import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Channel, ChannelSyncStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { HistoryImportService } from '../../messaging/pipeline/history-import.service';
import { MergedConversationError } from '../../messaging/conversations/merged-conversation';
import { HistorySyncPort } from '../ports/history-sync.port';
import {
  HistorySyncFilters,
  NormalizedHistoricalConversation,
} from '../ports/types';
import { CHANNEL_SYNC_QUEUE } from './channel-sync.constants';

interface SyncJobData {
  syncJobId: string;
  channelId: string;
}

const CONVERSATION_PAGE_SIZE = 50;
const MESSAGE_PAGE_SIZE = 50;
const MAX_CONVERSATIONS = 1000;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const REQUEST_DELAY_MS = 400;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 3;
/** Quantos ids externos de conversas que falharam ficam no metadata do job. */
const MAX_FAILED_IDS_RECORDED = 50;

@Processor(CHANNEL_SYNC_QUEUE, { concurrency: 1 })
export class ChannelSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ChannelSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly importer: HistoryImportService,
  ) {
    super();
  }

  async process(job: Job<SyncJobData>): Promise<any> {
    const { syncJobId, channelId } = job.data;

    const syncJob = await this.prisma.channelSyncJob.findUnique({
      where: { id: syncJobId },
    });
    if (!syncJob) {
      this.logger.warn(`Sync job ${syncJobId} not found — aborting`);
      return;
    }
    if (syncJob.status === ChannelSyncStatus.CANCELLED) {
      this.logger.log(`Sync job ${syncJobId} cancelled — aborting`);
      return;
    }

    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      await this.markFailed(syncJobId, 'Channel not found');
      return;
    }

    const adapter = this.registry.getHistorySync(channel.type);
    if (!adapter) {
      await this.markFailed(syncJobId, `No history sync adapter for ${channel.type}`);
      return;
    }

    await this.prisma.channelSyncJob.update({
      where: { id: syncJobId },
      data: { status: ChannelSyncStatus.RUNNING, startedAt: new Date() },
    });
    this.emitProgress(channel.organizationId, syncJobId, channelId, {
      status: ChannelSyncStatus.RUNNING,
      phase: 'starting',
    });

    const filters: HistorySyncFilters = {
      sinceTimestamp: new Date(Date.now() - syncJob.lookbackDays * 24 * 60 * 60 * 1000),
    };

    try {
      const conversations = await this.collectConversations(channel, adapter, filters);
      await this.prisma.channelSyncJob.update({
        where: { id: syncJobId },
        data: { conversationsTotal: conversations.length },
      });
      this.emitProgress(channel.organizationId, syncJobId, channelId, {
        status: ChannelSyncStatus.RUNNING,
        phase: 'importing',
        conversationsTotal: conversations.length,
      });

      let convImported = 0;
      let msgImported = 0;
      let contactsImported = 0;
      const seenContactIds = new Set<string>();
      const failed: string[] = [];

      for (const conv of conversations) {
        const cancelled = await this.isCancelled(syncJobId);
        if (cancelled) break;

        try {
          let importResult = await this.importer.importConversation(channel, conv);
          if (!seenContactIds.has(importResult.contactId)) {
            seenContactIds.add(importResult.contactId);
            if (importResult.isNew) contactsImported++;
          }

          let msgResult: number;
          try {
            msgResult = await this.importConversationMessages(
              channel,
              adapter,
              conv.externalConversationId,
              importResult.conversationId,
              filters,
            );
          } catch (err) {
            if (!(err instanceof MergedConversationError)) throw err;
            // A conversa virou extra fundida: re-resolve UMA vez pela
            // resolução padrão do importador (nunca escolhe extra fundida; no
            // WhatsApp, pessoa arquivada fica de fora) e reimporta — a
            // deduplicação por externalId evita repetir.
            importResult = await this.importer.importConversation(channel, conv);
            msgResult = await this.importConversationMessages(
              channel,
              adapter,
              conv.externalConversationId,
              importResult.conversationId,
              filters,
            );
          }
          msgImported += msgResult;
          // Só conta como importada a conversa cujas mensagens entraram.
          convImported++;

          // Publicar progresso (aviso à caixa, contadores do job, realtime)
          // é separado da importação: se só isso falhar, a conversa JÁ foi
          // importada e não vira pendência — o total final é gravado no fim.
          try {
            if (msgResult > 0) {
              await this.importer.notifyConversationImported(
                channel.organizationId,
                importResult.conversationId,
              );
            }

            await this.prisma.channelSyncJob.update({
              where: { id: syncJobId },
              data: {
                conversationsImported: convImported,
                messagesImported: msgImported,
                contactsImported,
              },
            });

            if (convImported % 5 === 0 || convImported === conversations.length) {
              this.emitProgress(channel.organizationId, syncJobId, channelId, {
                status: ChannelSyncStatus.RUNNING,
                phase: 'importing',
                conversationsTotal: conversations.length,
                conversationsImported: convImported,
                messagesImported: msgImported,
                contactsImported,
              });
            }
          } catch (progressErr: any) {
            this.logger.warn(
              `Progress publish failed for imported conversation ${conv.externalConversationId}: ${progressErr?.message ?? progressErr}`,
            );
          }
        } catch (err: any) {
          failed.push(conv.externalConversationId);
          this.logger.warn(
            `Failed to import conversation ${conv.externalConversationId}: ${err.message}`,
          );
        }
      }

      // Conversa que falhou é pendência recuperável: o job NÃO termina
      // COMPLETED limpo. Fica FAILED com a contagem e os ids externos;
      // rodar a sincronização de novo é seguro (dedup por externalId).
      const finalStatus = failed.length > 0 ? ChannelSyncStatus.FAILED : ChannelSyncStatus.COMPLETED;
      const errorMessage = failed.length > 0
        ? `${failed.length} de ${conversations.length} conversa(s) não importada(s); rode a sincronização de novo (é idempotente).`
        : null;
      await this.prisma.channelSyncJob.update({
        where: { id: syncJobId },
        data: {
          status: finalStatus,
          finishedAt: new Date(),
          conversationsImported: convImported,
          messagesImported: msgImported,
          contactsImported,
          ...(failed.length > 0
            ? {
                errorMessage,
                metadata: {
                  conversationsFailed: failed.length,
                  failedExternalConversationIds: failed.slice(0, MAX_FAILED_IDS_RECORDED),
                },
              }
            : {}),
        },
      });
      this.emitProgress(channel.organizationId, syncJobId, channelId, {
        status: finalStatus,
        phase: failed.length > 0 ? 'failed' : 'done',
        conversationsTotal: conversations.length,
        conversationsImported: convImported,
        messagesImported: msgImported,
        contactsImported,
        ...(errorMessage ? { errorMessage } : {}),
      });

      this.logger.log(
        `Sync ${syncJobId} ${failed.length > 0 ? 'finished with pending conversations' : 'complete'}: ${convImported}/${conversations.length} conversations, ${msgImported} messages, ${failed.length} failed`,
      );
    } catch (err: any) {
      this.logger.error(`Sync ${syncJobId} failed: ${err.message}`, err.stack);
      await this.markFailed(syncJobId, err.message);
      this.emitProgress(channel.organizationId, syncJobId, channelId, {
        status: ChannelSyncStatus.FAILED,
        phase: 'failed',
        errorMessage: err.message,
      });
      throw err;
    }
  }

  private async collectConversations(
    channel: Channel,
    adapter: HistorySyncPort,
    filters: HistorySyncFilters,
  ): Promise<NormalizedHistoricalConversation[]> {
    const all: NormalizedHistoricalConversation[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.withRateLimit(() =>
        adapter.fetchConversations(channel, filters, cursor, CONVERSATION_PAGE_SIZE),
      );
      all.push(...result.conversations);
      cursor = result.nextCursor;
      if (all.length >= MAX_CONVERSATIONS) break;
      await this.sleep(REQUEST_DELAY_MS);
    } while (cursor);
    return all;
  }

  private async importConversationMessages(
    channel: Channel,
    adapter: HistorySyncPort,
    externalConversationId: string,
    conversationId: string,
    filters: HistorySyncFilters,
  ): Promise<number> {
    let cursor: string | undefined;
    let imported = 0;
    do {
      const result = await this.withRateLimit(() =>
        adapter.fetchMessages(channel, externalConversationId, filters, cursor, MESSAGE_PAGE_SIZE),
      );
      if (result.messages.length === 0) break;

      const res = await this.importer.importMessages(
        channel,
        conversationId,
        result.messages,
      );
      // Count both newly-inserted and skipped (already-existing) messages.
      // Without `+ res.skipped`, re-syncs or races with inbound webhook
      // produce undercount (QA-S17-010): if 62/63 messages exist, reports 1.
      imported += res.imported + res.skipped;
      this.logger.debug(
        `importConversationMessages page: imported=${res.imported} skipped=${res.skipped} totalSoFar=${imported}`,
      );
      cursor = result.nextCursor;
      if (imported >= MAX_MESSAGES_PER_CONVERSATION) break;
      await this.sleep(REQUEST_DELAY_MS);
    } while (cursor);
    return imported;
  }

  private async isCancelled(syncJobId: string): Promise<boolean> {
    const current = await this.prisma.channelSyncJob.findUnique({
      where: { id: syncJobId },
      select: { status: true },
    });
    return current?.status === ChannelSyncStatus.CANCELLED;
  }

  private async markFailed(syncJobId: string, message: string): Promise<void> {
    await this.prisma.channelSyncJob.update({
      where: { id: syncJobId },
      data: {
        status: ChannelSyncStatus.FAILED,
        finishedAt: new Date(),
        errorMessage: message,
      },
    });
  }

  private emitProgress(
    organizationId: string,
    syncJobId: string,
    channelId: string,
    payload: Record<string, any>,
  ): void {
    this.realtimeGateway.emitToChannel(channelId, 'channel:sync-progress', {
      syncJobId,
      channelId,
      ...payload,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private isRateLimitError(err: any): boolean {
    const msg = err?.message || '';
    return /request limit reached|#4\]|#17\]|#32\]|#613\]|rate limit/i.test(msg);
  }

  private async withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: any) {
        if (!this.isRateLimitError(err) || attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw err;
        }
        attempt++;
        const delay = RATE_LIMIT_BACKOFF_MS * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Rate limit hit (attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES}). Backing off ${delay}ms...`,
        );
        await this.sleep(delay);
      }
    }
  }
}
