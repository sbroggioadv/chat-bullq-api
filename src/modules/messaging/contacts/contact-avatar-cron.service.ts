import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { ZappfyContactEnricherService } from '../../channel-hub/adapters/zappfy/zappfy-contact-enricher.service';
import { ContactsService } from './contacts.service';

/**
 * SPEC-003 W4 / S20 W2: re-enrich + rehost WhatsApp profile pictures.
 *
 * WhatsApp CDN avatar URLs expire ~14 days and often fail in the browser.
 * After fetch from Zappfy we rehost onto BullQ /uploads (stable URL).
 *
 * Feature flag: CONTACT_AVATAR_CRON_ENABLED=true
 */
@Injectable()
export class ContactAvatarCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContactAvatarCronService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly zappfyEnricher: ZappfyContactEnricherService,
    private readonly contactsService: ContactsService,
  ) {}

  onModuleInit(): void {
    const enabled =
      (process.env.CONTACT_AVATAR_CRON_ENABLED || '').toLowerCase() === 'true';
    if (!enabled) {
      this.logger.log(
        'contact_avatar_cron disabled (set CONTACT_AVATAR_CRON_ENABLED=true to enable)',
      );
      return;
    }

    const intervalMs =
      Number(process.env.CONTACT_AVATAR_CRON_MS) || 24 * 60 * 60 * 1000;
    // First pass soon after boot so redeploy actually refreshes avatars.
    const firstDelayMs =
      Number(process.env.CONTACT_AVATAR_CRON_FIRST_DELAY_MS) || 45_000;

    this.logger.log({
      msg: 'contact_avatar_cron_registered',
      intervalMs,
      firstDelayMs,
    });

    setTimeout(() => {
      void this.scanAndEnrich();
      this.timer = setInterval(() => void this.scanAndEnrich(), intervalMs);
      if (this.timer.unref) this.timer.unref();
    }, firstDelayMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scanAndEnrich(): Promise<{
    scanned: number;
    enriched: number;
    rehosted: number;
    skipped: number;
    failed: number;
  }> {
    if (this.running) {
      this.logger.warn('contact_avatar_cron already running — skip tick');
      return { scanned: 0, enriched: 0, rehosted: 0, skipped: 0, failed: 0 };
    }
    this.running = true;
    const start = Date.now();
    try {
      // All active WA contact-channels (cap 800/tick). Force-enrich + rehost.
      const targets = await this.prisma.contactChannel.findMany({
        where: {
          contact: { deletedAt: null },
          channel: {
            type: 'WHATSAPP_ZAPPFY',
            deletedAt: null,
            isActive: true,
          },
          externalId: { not: '' },
        },
        include: { channel: true },
        take: 800,
      });

      let enriched = 0;
      let rehosted = 0;
      let skipped = 0;
      let failed = 0;
      const CONCURRENCY = 5;

      for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const batch = targets.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (cc) => {
            try {
              const r = await this.zappfyEnricher.enrich(
                cc.channel as any,
                cc.externalId,
                { force: true },
              );
              if (r.enriched) enriched++;
              else if (r.reason === 'error') failed++;
              else skipped++;

              const contact = await this.prisma.contact.findUnique({
                where: { id: cc.contactId },
                select: { id: true, avatarUrl: true },
              });
              if (contact?.avatarUrl) {
                const ok = await this.contactsService.rehostAvatarToBullq(
                  contact.id,
                  contact.avatarUrl,
                );
                if (ok) rehosted++;
              }
            } catch {
              failed++;
            }
          }),
        );
      }

      this.logger.log({
        msg: 'contact_avatar_cron_done',
        scanned: targets.length,
        enriched,
        rehosted,
        skipped,
        failed,
        durationMs: Date.now() - start,
      });

      return {
        scanned: targets.length,
        enriched,
        rehosted,
        skipped,
        failed,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`contact_avatar_cron failed: ${msg}`);
      return { scanned: 0, enriched: 0, rehosted: 0, skipped: 0, failed: 1 };
    } finally {
      this.running = false;
    }
  }
}
