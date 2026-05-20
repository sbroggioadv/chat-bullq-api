import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { ContactsRepository } from './contacts.repository';
import { UpdateContactDto } from './dto/update-contact.dto';
import { PrismaService } from '../../../database/prisma.service';
import { ZappfyContactEnricherService } from '../../channel-hub/adapters/zappfy/zappfy-contact-enricher.service';

/**
 * S20 Wave 1: stats devolvidas pelo backfill de fotos do WhatsApp.
 * Frontend usa pra montar toast "X de Y contatos sincronizados".
 */
export interface SyncAvatarsResult {
  total: number;
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly repository: ContactsRepository,
    private readonly prisma: PrismaService,
    private readonly zappfyEnricher: ZappfyContactEnricherService,
  ) {}

  async findAll(organizationId: string, search: string | undefined, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const { contacts, total } = await this.repository.findByOrg(organizationId, search, skip, limit);
    return {
      contacts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
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
      include: { channel: true },
    });

    this.logger.log(
      `[sync-avatars] org=${organizationId} iniciando backfill de ${targets.length} contact-channels`,
    );

    let enriched = 0;
    let skipped = 0;
    let failed = 0;

    // Concorrencia limitada via chunks paralelos. Simples e suficiente
    // pra ~hundreds de contatos. Pra escala maior (10k+), migrar pra fila
    // BullMQ em background — fora do escopo da Wave 1.
    const CONCURRENCY = 5;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((cc) =>
          this.zappfyEnricher.enrich(cc.channel, cc.externalId, { force: true }),
        ),
      );
      for (const r of results) {
        if (r.enriched) enriched++;
        else if (r.reason === 'error') failed++;
        else skipped++;
      }
    }

    const durationMs = Date.now() - startMs;
    this.logger.log(
      `[sync-avatars] org=${organizationId} done — total=${targets.length} enriched=${enriched} skipped=${skipped} failed=${failed} duration=${durationMs}ms`,
    );

    return {
      total: targets.length,
      enriched,
      skipped,
      failed,
      durationMs,
    };
  }
}
