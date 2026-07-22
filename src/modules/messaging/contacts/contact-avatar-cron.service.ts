import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { ZappfyContactEnricherService } from '../../channel-hub/adapters/zappfy/zappfy-contact-enricher.service';

/**
 * SPEC-003 W4 / S20 W2: daily re-enrich of WhatsApp profile pictures.
 *
 * WhatsApp CDN avatar URLs expire ~14 days. Inbound enrich only fills
 * empty avatarUrl; stale non-null URLs stay broken forever without this.
 *
 * Feature flag: CONTACT_AVATAR_CRON_ENABLED=true (default false).
 * Interval: CONTACT_AVATAR_CRON_MS (default 24h) for tests; production
 * uses daily wall-clock via first run + 24h interval.
 *
 * Uses setInterval (same pattern as PendingActionCron) — no new queue.
 */
@Injectable()
export class ContactAvatarCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContactAvatarCronService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly zappfyEnricher: ZappfyContactEnricherService,
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

    const intervalMs = Number(process.env.CONTACT_AVATAR_CRON_MS) || 24 * 60 * 60 * 1000;
    // First pass after 2 min so boot/migrations settle; then interval.
    const firstDelayMs = Number(process.env.CONTACT_AVATAR_CRON_FIRST_DELAY_MS) || 2 * 60 * 1000;

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

  /**
   * Re-enrich contact-channels that have no avatar OR were last updated
   * more than 7 days ago (URL may have expired).
   */
  async scanAndEnrich(): Promise<{
    scanned: number;
    enriched: number;
    skipped: number;
    failed: number;
  }> {
    if (this.running) {
      this.logger.warn('contact_avatar_cron already running — skip tick');
      return { scanned: 0, enriched: 0, skipped: 0, failed: 0 };
    }
    this.running = true;
    const start = Date.now();
    try {
      const staleBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const targets = await this.prisma.contactChannel.findMany({
        where: {
          contact: { deletedAt: null },
          channel: {
            type: 'WHATSAPP_ZAPPFY',
            deletedAt: null,
            isActive: true,
          },
          externalId: { not: '' },
          OR: [
            { contact: { avatarUrl: null } },
            { contact: { updatedAt: { lt: staleBefore } } },
          ],
        },
        include: { channel: true },
        take: 500,
      });

      let enriched = 0;
      let skipped = 0;
      let failed = 0;
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

      this.logger.log({
        msg: 'contact_avatar_cron_done',
        scanned: targets.length,
        enriched,
        skipped,
        failed,
        durationMs: Date.now() - start,
      });

      return { scanned: targets.length, enriched, skipped, failed };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`contact_avatar_cron failed: ${msg}`);
      return { scanned: 0, enriched: 0, skipped: 0, failed: 1 };
    } finally {
      this.running = false;
    }
  }
}
