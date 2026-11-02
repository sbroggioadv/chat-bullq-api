import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Marca que a limpeza de duplicadas grava na conversa EXTRA ao fundi-la na
 * original (scripts/ops/2026-11-02-limpar-duplicadas/02-aplicar.sql): o valor
 * é o id da original. O desfazer da limpeza remove a chave.
 *
 * Extra fundida ≠ conversa arquivada pelo usuário: arquivar à mão não grava
 * esta chave, e uma conversa arquivada pelo usuário continua aceitando envio.
 */
export const MERGED_INTO_KEY = 'cleanup_merged_into';

/** Id da original se a conversa é extra fundida; senão `null`. */
export function mergedOriginalId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[MERGED_INTO_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Recusa (422 `conversation_merged`, sem efeito colateral) ações que
 * reativariam atendimento numa extra fundida: ligar/fixar/acionar IA, reabrir,
 * mudar de estado (exceto encerrar) e atribuir. Conversa só arquivada pelo
 * usuário NÃO é afetada — a regra depende só da marca da fusão.
 */
export function assertNotMergedExtra(conversation: { id: string; metadata?: unknown }, action: string): void {
  const mergedInto = mergedOriginalId(conversation.metadata);
  if (!mergedInto) return;
  throw new UnprocessableEntityException({
    message: 'Esta conversa foi unida a outra. Use a conversa original.',
    code: 'conversation_merged',
    action,
    conversationId: conversation.id,
    mergedInto,
  });
}

/**
 * Quantas candidatas as seleções automáticas (resolvedor, importador) leem
 * para pular extras fundidas pela marca — mesmo as que alguém desarquivou.
 * A marca é JSON; o filtro fica no código (sem depender da semântica de nulo
 * de filtro JSON do Prisma). Mais de 10 extras fundidas abertas para o mesmo
 * contato não ocorre; se ocorrer, cai no caminho de "nenhuma aberta".
 */
export const MERGED_SCAN_LIMIT = 10;

/** Primeira candidata (na ordem recebida) que NÃO é extra fundida. */
export function firstNotMerged<T extends { metadata?: unknown }>(rows: T[]): T | null {
  return rows.find((r) => !mergedOriginalId(r.metadata)) ?? null;
}

/** O destino de uma escrita é extra fundida: nada foi gravado; o chamador re-resolve. */
export class MergedConversationError extends Error {
  constructor(readonly conversationId: string) {
    super('conversation_merged');
    this.name = 'MergedConversationError';
  }
}

type ConversationReader = {
  conversation: {
    findUnique(args: { where: { id: string }; select: { metadata: true } }): Promise<{ metadata: unknown } | null>;
  };
};

/**
 * Leitura COMUM (sem `FOR SHARE`/`FOR UPDATE`) antes de gravar mensagem que
 * entra (inbound, importação). Lock compartilhado aqui levava dois inbounds da
 * mesma conversa a deadlock ao atualizar `last_message_at` (parecer-revisor-api-2,
 * item 4). A corrida residual com a fusão é coberta pela janela sem escritores.
 */
export async function throwIfMergedExtra(db: ConversationReader, conversationId: string): Promise<void> {
  const row = await db.conversation.findUnique({ where: { id: conversationId }, select: { metadata: true } });
  if (mergedOriginalId(row?.metadata)) throw new MergedConversationError(conversationId);
}
