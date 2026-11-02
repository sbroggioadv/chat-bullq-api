import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, UnrecoverableError } from 'bullmq';
import { MessageDirection } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { UploadsService } from './uploads.service';
import {
  MediaDownloadError,
  MetaMediaDownloader,
  hostOf,
  isMirrorableMetaMediaUrl,
} from './meta-media-downloader';

/**
 * SPEC-017 — espelha na nossa storage a mídia que o Instagram entrega em CDN
 * da Meta (links assinados que expiram em horas). A mensagem é gravada
 * primeiro; o espelhamento roda depois, em fila, por melhor esforço, e nunca
 * falha a mensagem: se esgotar as tentativas, o link original fica e o motivo
 * vai para `metadata.mediaMirror`.
 *
 * Nada aqui loga a URL da Meta: só id da mensagem, host e código/status.
 * O job leva só ids; a URL é relida do banco.
 */

export const INBOUND_MEDIA_MIRROR_QUEUE = 'inbound-media-mirror';

/** Recuo entre tentativas: 1ª imediata, depois 30 s, 2 min e 10 min. */
export const MIRROR_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
export const MIRROR_JOB_ATTEMPTS = 1 + MIRROR_RETRY_DELAYS_MS.length;

/** backoffStrategy do worker (BullMQ chama com o nº de tentativas já feitas). */
export function mirrorBackoffStrategy(attemptsMade: number): number {
  const i = Math.min(Math.max(attemptsMade, 1), MIRROR_RETRY_DELAYS_MS.length) - 1;
  return MIRROR_RETRY_DELAYS_MS[i];
}

export interface MirrorJobData {
  messageId: string;
  channelId: string;
}

export interface MirrorableMessage {
  id: string;
  direction: MessageDirection | string;
  type?: string;
  content: unknown;
  metadata: unknown;
}

export type MirrorRunResult =
  | { status: 'not_found' }
  | { status: 'noop' }
  | { status: 'mirrored'; fields: Array<'media' | 'story'> };

interface MirrorTargets {
  mediaUrl?: string;
  storyUrl?: string;
}

interface MirrorFailure {
  reason: string;
  retryable: boolean;
  status?: number;
}

const asRecord = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};

/** URL já servida por nós (`/api/v1/uploads/...`): não há o que espelhar. */
export function isOwnUploadUrl(url: unknown): boolean {
  return typeof url === 'string' && url.includes('/api/v1/uploads/');
}

/** Quais campos da mensagem apontam para mídia espelhável no CDN da Meta. */
export function collectMirrorTargets(message: MirrorableMessage): MirrorTargets {
  const targets: MirrorTargets = {};
  const mediaUrl = asRecord(message.content).mediaUrl;
  if (
    message.type !== 'DOCUMENT' &&
    !isOwnUploadUrl(mediaUrl) &&
    isMirrorableMetaMediaUrl(mediaUrl)
  ) {
    targets.mediaUrl = mediaUrl;
  }
  const storyUrl = asRecord(asRecord(asRecord(message.metadata).replyTo).story).url;
  if (!isOwnUploadUrl(storyUrl) && isMirrorableMetaMediaUrl(storyUrl)) {
    targets.storyUrl = storyUrl;
  }
  return targets;
}

const errorName = (err: unknown): string =>
  err instanceof Error ? err.name : typeof err;

@Injectable()
export class InboundMediaMirrorService {
  private readonly logger = new Logger(InboundMediaMirrorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
    private readonly downloader: MetaMediaDownloader,
    @InjectQueue(INBOUND_MEDIA_MIRROR_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Enfileira o espelhamento de uma mensagem do Instagram já gravada, nas duas
   * direções: recebida e eco (enviada pelo app do Instagram, também em CDN da
   * Meta). Mensagem enviada pelo BullQ já tem URL nossa e cai fora pela regra
   * de "URL já é nossa". Nunca lança: qualquer falha é logada e a mensagem
   * segue como está.
   */
  async enqueueForMessage(message: MirrorableMessage, channelId: string): Promise<boolean> {
    try {
      const targets = collectMirrorTargets(message);
      if (!targets.mediaUrl && !targets.storyUrl) return false;
      await this.queue.add(
        'mirror',
        { messageId: message.id, channelId } satisfies MirrorJobData,
        {
          jobId: `mirror-${message.id}`,
          attempts: MIRROR_JOB_ATTEMPTS,
          backoff: { type: 'custom' },
          removeOnComplete: true,
          removeOnFail: { count: 1000 },
        },
      );
      return true;
    } catch (err) {
      this.logger.warn({
        msg: 'ig_media_mirror_enqueue_failed',
        messageId: message?.id,
        error: errorName(err),
      });
      return false;
    }
  }

  /**
   * Caminho da importação de histórico: as linhas foram gravadas em lote
   * (createMany), então relemos as criadas (recebidas e ecos) pelo externalId.
   * Nunca lança.
   */
  async enqueueImported(
    channelId: string,
    conversationId: string,
    externalIds: string[],
  ): Promise<number> {
    if (!externalIds.length) return 0;
    try {
      const rows = await this.prisma.message.findMany({
        where: { conversationId, externalId: { in: externalIds } },
        select: { id: true, direction: true, type: true, content: true, metadata: true },
      });
      let enqueued = 0;
      for (const row of rows) {
        if (await this.enqueueForMessage(row, channelId)) enqueued++;
      }
      return enqueued;
    } catch (err) {
      this.logger.warn({
        msg: 'ig_media_mirror_enqueue_imported_failed',
        conversationId,
        error: errorName(err),
      });
      return 0;
    }
  }

  /**
   * Executa um job. Idempotente: relê a mensagem e só age sobre campos que
   * ainda apontam para o CDN da Meta. Lança para o BullMQ retentar; na última
   * tentativa (ou em falha não-retentável) grava o motivo e lança
   * UnrecoverableError. A mensagem nunca é marcada como falha.
   */
  async runJob(data: MirrorJobData, opts: { isFinalAttempt: boolean }): Promise<MirrorRunResult> {
    const message = await this.prisma.message.findUnique({
      where: { id: data.messageId },
      select: { id: true, direction: true, type: true, content: true, metadata: true },
    });
    if (!message) return { status: 'not_found' };

    const targets = collectMirrorTargets(message);
    if (!targets.mediaUrl && !targets.storyUrl) return { status: 'noop' };

    const savedByOriginal = new Map<string, string>();
    const done: Array<'media' | 'story'> = [];
    let failure: MirrorFailure | undefined;

    const mirrorField = async (field: 'media' | 'story', original: string) => {
      const host = hostOf(original);
      try {
        let ours = savedByOriginal.get(original);
        if (!ours) {
          const media = await this.downloader.download(original);
          const saved = await this.uploads.saveInboundMedia({
            buffer: media.buffer,
            mimeType: media.mimeType,
            channelId: data.channelId,
          });
          ours = saved.url;
          savedByOriginal.set(original, ours);
        }
        const rows =
          field === 'media'
            ? await this.swapContentMediaUrl(message.id, original, ours)
            : await this.swapStoryUrl(message.id, original, ours);
        done.push(field);
        this.logger.log({ msg: 'ig_media_mirrored', messageId: message.id, host, field, rows });
      } catch (err) {
        const f: MirrorFailure =
          err instanceof MediaDownloadError
            ? { reason: err.reason, retryable: err.retryable, status: err.status }
            : { reason: 'store_failed', retryable: true };
        failure ??= f;
        this.logger.warn({
          msg: 'ig_media_mirror_failed',
          messageId: message.id,
          host,
          field,
          reason: f.reason,
          status: f.status,
          error: err instanceof MediaDownloadError ? undefined : errorName(err),
          final: opts.isFinalAttempt || !f.retryable,
        });
      }
    };

    if (targets.mediaUrl) await mirrorField('media', targets.mediaUrl);
    if (targets.storyUrl) await mirrorField('story', targets.storyUrl);

    if (!failure) return { status: 'mirrored', fields: done };

    const code = failure.status ? `${failure.reason}:${failure.status}` : failure.reason;
    if (opts.isFinalAttempt || !failure.retryable) {
      await this.recordFailure(message.id, failure);
      throw new UnrecoverableError(code);
    }
    throw new Error(code);
  }

  /** Troca content.mediaUrl só se ainda for o link original (compare-and-set). */
  private swapContentMediaUrl(id: string, original: string, ours: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "messages"
      SET "content" = jsonb_set("content", '{mediaUrl}', to_jsonb(${ours}::text)),
          "metadata" = COALESCE("metadata", '{}'::jsonb)
            || jsonb_build_object('originalMediaUrl', ${original}::text)
      WHERE "id" = ${id} AND "content"->>'mediaUrl' = ${original}`;
  }

  /** Troca metadata.replyTo.story.url só se ainda for o link original. */
  private swapStoryUrl(id: string, original: string, ours: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "messages"
      SET "metadata" = jsonb_set(
            jsonb_set("metadata", '{replyTo,story,url}', to_jsonb(${ours}::text)),
            '{replyTo,story,originalUrl}', to_jsonb(${original}::text))
      WHERE "id" = ${id} AND "metadata" #>> '{replyTo,story,url}' = ${original}`;
  }

  /** Registra o motivo da desistência; nunca lança. */
  private async recordFailure(id: string, failure: MirrorFailure): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "messages"
        SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
              'mediaMirror', jsonb_build_object(
                'status', 'failed',
                'reason', ${failure.reason}::text,
                'httpStatus', ${failure.status ?? null}::int,
                'at', ${new Date().toISOString()}::text))
        WHERE "id" = ${id}`;
    } catch (err) {
      this.logger.warn({
        msg: 'ig_media_mirror_record_failure_failed',
        messageId: id,
        error: errorName(err),
      });
    }
  }
}
