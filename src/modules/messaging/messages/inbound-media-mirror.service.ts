import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, UnrecoverableError } from 'bullmq';
import { MessageDirection } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { mergedOriginalId } from '../conversations/merged-conversation';
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
  | { status: 'mirrored'; fields: Array<'media' | 'story'>; conflicts?: Array<'media' | 'story'> }
  | { status: 'conflict'; conflicts: Array<'media' | 'story'> }
  | { status: 'skipped'; reason: 'conversation_merged' };

interface MirrorTargets {
  mediaUrl?: string;
  storyUrl?: string;
}

type MirrorField = 'media' | 'story';

interface MirrorFailure {
  reason: string;
  retryable: boolean;
  status?: number;
}

const failureCode = (f: MirrorFailure): string =>
  f.status ? `${f.reason}:${f.status}` : f.reason;

/**
 * Identidade segura de uma URL da Meta para o registro de falha: os 16
 * primeiros hex do SHA-256. Permite saber se a falha registrada é da URL
 * atual sem guardar a URL (assinada) em outro lugar.
 */
export function mirrorUrlRef(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** A falha registrada para o campo é da URL que ele tem agora? */
function failedFor(record: unknown, currentUrl: string): boolean {
  const r = asRecord(record);
  return r.status === 'failed' && r.urlRef === mirrorUrlRef(currentUrl);
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
      select: {
        id: true,
        direction: true,
        type: true,
        content: true,
        metadata: true,
        conversation: { select: { metadata: true } },
      },
    });
    if (!message) return { status: 'not_found' };

    // Extra fundida pela limpeza de duplicadas: não escreve nada, não retenta.
    // Só a marca da fusão conta — conversa arquivada pelo usuário segue normal.
    // Os UPDATEs repetem a checagem no WHERE para cobrir a fusão que acontecer
    // entre esta leitura e a escrita.
    if (mergedOriginalId(message.conversation?.metadata)) {
      this.logger.log({
        msg: 'ig_media_mirror_skipped',
        messageId: message.id,
        reason: 'conversation_merged',
      });
      return { status: 'skipped', reason: 'conversation_merged' };
    }

    // Cada campo é independente: uma desistência num não impede nem encerra
    // a tentativa do outro. A desistência registrada vale só para a URL que
    // falhou (urlRef): se o campo hoje aponta para outra URL, tenta de novo.
    const targets = collectMirrorTargets(message);
    const recorded = asRecord(asRecord(message.metadata).mediaMirror);
    const work: Array<[MirrorField, string]> = [];
    if (targets.mediaUrl && !failedFor(recorded.media, targets.mediaUrl)) {
      work.push(['media', targets.mediaUrl]);
    }
    if (targets.storyUrl && !failedFor(recorded.story, targets.storyUrl)) {
      work.push(['story', targets.storyUrl]);
    }
    if (!work.length) return { status: 'noop' };

    // Menção a story: a mesma URL nos dois campos é baixada uma vez só.
    const storedByOriginal = new Map<string, Promise<string>>();
    const store = (original: string): Promise<string> => {
      let pending = storedByOriginal.get(original);
      if (!pending) {
        pending = this.downloader.download(original).then(async (media) => {
          const saved = await this.uploads.saveInboundMedia({
            buffer: media.buffer,
            mimeType: media.mimeType,
            channelId: data.channelId,
          });
          return saved.url;
        });
        storedByOriginal.set(original, pending);
      }
      return pending;
    };

    const done: MirrorField[] = [];
    const conflicts: MirrorField[] = [];
    // Arquivos que NÃO podem ser apagados: referenciados por um UPDATE que
    // confirmou a troca, ou cujo UPDATE terminou em exceção (resultado
    // incerto — o banco pode ter gravado e a resposta se perdido).
    const keep = new Set<string>();
    const failures: Array<[MirrorField, MirrorFailure]> = [];
    const fail = (field: MirrorField, host: string | null, f: MirrorFailure, err: unknown) => {
      failures.push([field, f]);
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
    };
    for (const [field, original] of work) {
      const host = hostOf(original);
      let ours: string;
      try {
        ours = await store(original);
      } catch (err) {
        fail(
          field,
          host,
          err instanceof MediaDownloadError
            ? { reason: err.reason, retryable: err.retryable, status: err.status }
            : { reason: 'store_failed', retryable: true },
          err,
        );
        continue;
      }
      let rows: number;
      try {
        rows =
          field === 'media'
            ? await this.swapContentMediaUrl(message.id, original, ours)
            : await this.swapStoryUrl(message.id, original, ours);
      } catch (err) {
        // Resultado incerto: o arquivo fica (órfão é inofensivo; link
        // quebrado não é) e o job retenta; se a troca tiver sido gravada, a
        // próxima tentativa vê a URL nossa e vira no-op.
        keep.add(ours);
        fail(field, host, { reason: 'update_uncertain', retryable: true }, err);
        continue;
      }
      if (rows === 0) {
        // Resultado definitivo de 0 linhas: a URL do campo mudou ou a conversa
        // foi fundida entre a leitura e a escrita. Nem sucesso nem falha.
        conflicts.push(field);
        this.logger.warn({ msg: 'ig_media_mirror_conflict', messageId: message.id, host, field, reason: 'conflict' });
        continue;
      }
      keep.add(ours);
      done.push(field);
      this.logger.log({ msg: 'ig_media_mirrored', messageId: message.id, host, field, rows });
    }

    // Só o arquivo cujo(s) UPDATE(s) devolveu(ram) 0 linhas DEFINITIVAS é
    // apagado na hora; sem isso ele ficaria órfão na storage.
    await this.deleteUnreferenced(message.id, storedByOriginal, keep);

    if (!failures.length) {
      if (!done.length && conflicts.length) return { status: 'conflict', conflicts };
      return conflicts.length
        ? { status: 'mirrored', fields: done, conflicts }
        : { status: 'mirrored', fields: done };
    }

    // Desistência definitiva (permanente, ou transitória na última tentativa)
    // é registrada por campo; transitória antes da última tentativa retenta
    // o job inteiro (os campos já espelhados viram no-op na próxima).
    const originalOf = new Map(work);
    for (const [field, f] of failures) {
      if (!f.retryable || opts.isFinalAttempt) {
        await this.recordFailure(message.id, field, originalOf.get(field)!, f);
      }
    }
    const transient = failures.find(([, f]) => f.retryable);
    if (transient && !opts.isFinalAttempt) throw new Error(failureCode(transient[1]));
    throw new UnrecoverableError(failureCode(failures[0][1]));
  }

  /**
   * Apaga os arquivos salvos neste job que não estão em `keep`. Nunca lança:
   * limpeza que não acontece é avisada com código inequívoco (sem chave nem
   * URL) e o job segue.
   */
  private async deleteUnreferenced(
    messageId: string,
    stored: Map<string, Promise<string>>,
    keep: Set<string>,
  ): Promise<void> {
    for (const pending of stored.values()) {
      const ours = await pending.catch(() => null);
      if (!ours || keep.has(ours)) continue;
      try {
        const deleted = await this.uploads.deleteInboundMedia(ours);
        if (deleted) {
          this.logger.log({ msg: 'ig_media_mirror_orphan_deleted', messageId });
        } else {
          this.logger.warn({
            msg: 'ig_media_mirror_orphan_delete_failed',
            messageId,
            reason: 'orphan_delete_refused',
          });
        }
      } catch (err) {
        this.logger.warn({
          msg: 'ig_media_mirror_orphan_delete_failed',
          messageId,
          reason: 'orphan_delete_error',
          error: errorName(err),
        });
      }
    }
  }

  // SQL: `metadata`/`content` podem guardar JSON que não é objeto (escalar,
  // null, array). `||` com não-objeto vira ARRAY (provado em Postgres 16), por
  // isso toda escrita parte de `CASE WHEN jsonb_typeof(...) = 'object'`.

  /** Troca content.mediaUrl só se ainda for o link original (compare-and-set). */
  private swapContentMediaUrl(id: string, original: string, ours: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "messages"
      SET "content" = jsonb_set("content", '{mediaUrl}', to_jsonb(${ours}::text)),
          "metadata" = (CASE WHEN jsonb_typeof("metadata") = 'object'
                             THEN "metadata" ELSE '{}'::jsonb END)
            || jsonb_build_object('originalMediaUrl', ${original}::text)
      WHERE "id" = ${id}
        AND jsonb_typeof("content") = 'object'
        AND "content"->>'mediaUrl' = ${original}
        AND NOT EXISTS (
          SELECT 1 FROM "conversations" c
          WHERE c."id" = "messages"."conversation_id"
            AND jsonb_typeof(c."metadata" -> 'cleanup_merged_into') = 'string'
            AND c."metadata" ->> 'cleanup_merged_into' <> '')`;
  }

  /** Troca metadata.replyTo.story.url só se ainda for o link original. */
  private swapStoryUrl(id: string, original: string, ours: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "messages"
      SET "metadata" = jsonb_set(
            jsonb_set("metadata", '{replyTo,story,url}', to_jsonb(${ours}::text)),
            '{replyTo,story,originalUrl}', to_jsonb(${original}::text))
      WHERE "id" = ${id}
        AND jsonb_typeof("metadata") = 'object'
        AND jsonb_typeof("metadata" #> '{replyTo,story}') = 'object'
        AND "metadata" #>> '{replyTo,story,url}' = ${original}
        AND NOT EXISTS (
          SELECT 1 FROM "conversations" c
          WHERE c."id" = "messages"."conversation_id"
            AND jsonb_typeof(c."metadata" -> 'cleanup_merged_into') = 'string'
            AND c."metadata" ->> 'cleanup_merged_into' <> '')`;
  }

  /**
   * Registra a desistência de UM campo em metadata.mediaMirror.<campo>,
   * preservando o registro do outro campo. Compare-and-set: só grava se o
   * campo ainda aponta para a URL que falhou (se ela mudou durante o
   * download, a falha antiga não marca a nova). Guarda `urlRef` (hash curto),
   * nunca a URL. Nunca lança.
   */
  private async recordFailure(
    id: string,
    field: MirrorField,
    original: string,
    failure: MirrorFailure,
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "messages"
        SET "metadata" = jsonb_set(
              (CASE WHEN jsonb_typeof("metadata") = 'object'
                    THEN "metadata" ELSE '{}'::jsonb END),
              '{mediaMirror}',
              (CASE WHEN jsonb_typeof("metadata" -> 'mediaMirror') = 'object'
                    THEN "metadata" -> 'mediaMirror' ELSE '{}'::jsonb END)
                || jsonb_build_object(${field}::text, jsonb_build_object(
                     'status', 'failed',
                     'reason', ${failure.reason}::text,
                     'httpStatus', ${failure.status ?? null}::int,
                     'urlRef', ${mirrorUrlRef(original)}::text,
                     'at', ${new Date().toISOString()}::text)))
        WHERE "id" = ${id}
          AND (
            (${field}::text = 'media'
              AND jsonb_typeof("content") = 'object'
              AND "content"->>'mediaUrl' = ${original})
            OR (${field}::text = 'story'
              AND jsonb_typeof("metadata") = 'object'
              AND jsonb_typeof("metadata" #> '{replyTo,story}') = 'object'
              AND "metadata" #>> '{replyTo,story,url}' = ${original}))
          AND NOT EXISTS (
            SELECT 1 FROM "conversations" c
            WHERE c."id" = "messages"."conversation_id"
              AND jsonb_typeof(c."metadata" -> 'cleanup_merged_into') = 'string'
              AND c."metadata" ->> 'cleanup_merged_into' <> '')`;
    } catch (err) {
      this.logger.warn({
        msg: 'ig_media_mirror_record_failure_failed',
        messageId: id,
        error: errorName(err),
      });
    }
  }
}
