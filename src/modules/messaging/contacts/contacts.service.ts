import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import axios from 'axios';
import { ContactsRepository } from './contacts.repository';
import { UpdateContactDto } from './dto/update-contact.dto';
import { PrismaService } from '../../../database/prisma.service';
import { ZappfyContactEnricherService } from '../../channel-hub/adapters/zappfy/zappfy-contact-enricher.service';
import { UploadsService } from '../messages/uploads.service';

/**
 * S20 Wave 1: stats devolvidas pelo backfill de fotos do WhatsApp.
 * Frontend usa pra montar toast "X de Y contatos sincronizados".
 */
export interface SyncAvatarsResult {
  total: number;
  enriched: number;
  skipped: number;
  failed: number;
  rehosted: number;
  durationMs: number;
}

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly repository: ContactsRepository,
    private readonly prisma: PrismaService,
    private readonly zappfyEnricher: ZappfyContactEnricherService,
    private readonly uploads: UploadsService,
  ) {}

  async findAll(
    organizationId: string,
    search: string | undefined,
    page: number,
    limit: number,
    opts?: { shareableOnly?: boolean },
  ) {
    const skip = (page - 1) * limit;
    const { contacts, total } = await this.repository.findByOrg(
      organizationId,
      search,
      skip,
      limit,
      opts,
    );

    // Post-filter for shareable: real E.164-ish phone + human-readable name.
    // Prisma can't easily express "digits only" — do it here for share picker.
    let list = contacts;
    if (opts?.shareableOnly) {
      list = contacts.filter((c) => this.isShareableContact(c));
    }

    // Enrich displayName for the UI (name → channel profileName → cleaned phone)
    const enriched = list.map((c) => ({
      ...c,
      displayName: this.resolveDisplayName(c),
    }));

    return {
      contacts: enriched,
      pagination: {
        page,
        limit,
        total: opts?.shareableOnly ? enriched.length : total,
        totalPages: Math.ceil(
          (opts?.shareableOnly ? enriched.length : total) / limit,
        ),
      },
    };
  }

  /** Real phone (digits, 10–15) and not a WhatsApp @lid / junk id. */
  private isShareableContact(c: {
    name?: string | null;
    phone?: string | null;
    channels?: Array<{ profileName?: string | null; externalId?: string | null }>;
  }): boolean {
    const phone = (c.phone || '').trim();
    if (!phone || phone.includes('@') || /lid/i.test(phone)) return false;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return false;
    // Must have some human label somewhere
    const label = this.resolveDisplayName(c);
    if (!label || label.includes('@') || /lid/i.test(label)) return false;
    // Reject pure-digit "names" that are just the phone or LID fragment
    if (/^\d{10,}$/.test(label.replace(/\D/g, '')) && !c.name?.trim()) {
      // allow if profileName exists
      const hasProfile = c.channels?.some((ch) => !!ch.profileName?.trim());
      if (!hasProfile) return false;
    }
    return true;
  }

  private resolveDisplayName(c: {
    name?: string | null;
    phone?: string | null;
    channels?: Array<{ profileName?: string | null }>;
  }): string {
    const name = c.name?.trim();
    if (name && !name.includes('@') && !/lid/i.test(name)) return name;
    const profile = c.channels
      ?.map((ch) => ch.profileName?.trim())
      .find((p) => p && !p.includes('@') && !/lid/i.test(p));
    if (profile) return profile;
    const phone = (c.phone || '').trim();
    if (phone && !phone.includes('@')) return phone;
    return 'Sem nome';
  }

  async findOne(id: string, organizationId: string) {
    const contact = await this.repository.findById(id);
    if (!contact) throw new NotFoundException('Contact not found');
    if (contact.organizationId !== organizationId) throw new ForbiddenException();
    return contact;
  }

  async update(id: string, organizationId: string, dto: UpdateContactDto) {
    const existing = await this.findOne(id, organizationId);

    // When the operator explicitly sets a name we MUST mark the contact as
    // "name-locked-by-user" so the inbound pipeline doesn't overwrite it on
    // the next authoritative pushName arrival. We merge into existing
    // metadata to avoid wiping unrelated keys.
    let nextMetadata = dto.metadata;
    if (dto.name !== undefined && dto.name !== null) {
      const currentMeta =
        (existing.metadata as Record<string, any> | null | undefined) ?? {};
      nextMetadata = {
        ...currentMeta,
        ...(dto.metadata ?? {}),
        nameLockedByUser: true,
        nameLockedAt: new Date().toISOString(),
      };
    }

    return this.repository.update(id, {
      ...dto,
      ...(nextMetadata !== undefined ? { metadata: nextMetadata } : {}),
    });
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    return this.repository.softDelete(id);
  }

  /**
   * S20 Wave 1: backfill sincrono de fotos de perfil do WhatsApp pra todos
   * os contatos da org. Itera ContactChannel cujo canal e WHATSAPP_ZAPPFY,
   * chama o enricher com force=true (re-fetch mesmo se ja tem foto — URLs
   * do WhatsApp expiram em ~14 dias).
   *
   * Concorrencia limitada (5 paralelos) pra nao saturar a API Zappfy e
   * nao bloquear o event loop com 100+ chamadas em paralelo. Pra ~100
   * contatos: ~30s.
   *
   * RBAC enforcement no controller (OWNER/ADMIN only) — operacao cara.
   */
  async syncWhatsAppAvatars(organizationId: string): Promise<SyncAvatarsResult> {
    const startMs = Date.now();
    const targets = await this.prisma.contactChannel.findMany({
      where: {
        contact: { organizationId, deletedAt: null },
        channel: {
          organizationId,
          type: 'WHATSAPP_ZAPPFY',
          deletedAt: null,
          isActive: true,
        },
        externalId: { not: '' },
      },
      include: { channel: true, contact: { select: { id: true, avatarUrl: true } } },
    });

    this.logger.log(
      `[sync-avatars] org=${organizationId} iniciando backfill de ${targets.length} contact-channels`,
    );

    let enriched = 0;
    let skipped = 0;
    let failed = 0;
    let rehosted = 0;

    // Concorrencia limitada via chunks paralelos. Simples e suficiente
    // pra ~hundreds de contatos. Pra escala maior (10k+), migrar pra fila
    // BullMQ em background — fora do escopo da Wave 1.
    const CONCURRENCY = 5;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (cc) => {
          const r = await this.zappfyEnricher.enrich(cc.channel, cc.externalId, {
            force: true,
          });
          // Always try rehost after force-enrich: WhatsApp CDN URLs expire ~14d
          // and the browser often can't load them (hotlink/expiry).
          const contact = await this.prisma.contact.findUnique({
            where: { id: cc.contactId },
            select: { id: true, avatarUrl: true },
          });
          if (contact?.avatarUrl) {
            const ok = await this.rehostAvatarToBullq(contact.id, contact.avatarUrl);
            if (ok) rehosted++;
          }
          return r;
        }),
      );
      for (const r of results) {
        if (r.enriched) enriched++;
        else if (r.reason === 'error') failed++;
        else skipped++;
      }
    }

    const durationMs = Date.now() - startMs;
    this.logger.log(
      `[sync-avatars] org=${organizationId} done — total=${targets.length} enriched=${enriched} rehosted=${rehosted} skipped=${skipped} failed=${failed} duration=${durationMs}ms`,
    );

    return {
      total: targets.length,
      enriched,
      skipped,
      failed,
      rehosted,
      durationMs,
    };
  }

  /**
   * Download a remote WhatsApp/Zappfy profile pic and store it on BullQ
   * uploads so the URL never expires. No-op if already a BullQ /uploads URL.
   */
  async rehostAvatarToBullq(
    contactId: string,
    avatarUrl: string,
  ): Promise<boolean> {
    if (!avatarUrl || !avatarUrl.startsWith('http')) return false;
    if (avatarUrl.includes('/api/v1/uploads/')) return false;
    try {
      const resp = await axios.get(avatarUrl, {
        responseType: 'arraybuffer',
        timeout: 25_000,
        headers: {
          // Some CDNs reject empty UA
          'User-Agent': 'BullQ-AvatarSync/1.0',
        },
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const buffer = Buffer.from(resp.data);
      if (buffer.length < 100) return false;
      const headerMime = resp.headers['content-type'];
      const mime =
        typeof headerMime === 'string' && headerMime.startsWith('image/')
          ? headerMime.split(';')[0].trim()
          : 'image/jpeg';
      const saved = await this.uploads.saveInboundMedia({
        buffer,
        mimeType: mime,
        channelId: 'avatars',
        originalFilename: `avatar-${contactId}.jpg`,
      });
      await this.prisma.contact.update({
        where: { id: contactId },
        data: { avatarUrl: saved.url },
      });
      this.logger.log(
        `Avatar rehosted contact=${contactId} -> ${saved.url} (${buffer.length}b)`,
      );
      return true;
    } catch (err: any) {
      this.logger.warn(
        `Avatar rehost failed contact=${contactId}: ${err.message}`,
      );
      return false;
    }
  }
}
