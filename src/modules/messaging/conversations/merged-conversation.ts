import { ConversationStatus, Prisma } from '@prisma/client';

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

/** A extra foi fundida e a original não serve de destino (sumiu, outra org/canal ou deletada). */
export class MergedConversationError extends Error {
  constructor(readonly conversationId: string) {
    super('conversation_merged_original_unavailable');
    this.name = 'MergedConversationError';
  }
}

export interface WritableConversation {
  id: string;
  /** Status lido na mesma transação; `null` se a conversa não existe. */
  status: ConversationStatus | null;
  /** Id da extra fundida de onde a escrita foi desviada, se houve desvio. */
  redirectedFrom: string | null;
}

/**
 * Destino gravável para mensagem que ENTRA (inbound, importação), revalidado
 * dentro da transação do chamador. `FOR SHARE` espera uma fusão em curso (a
 * limpeza trava a extra `FOR UPDATE`) e lê o estado já commitado. Se o destino
 * virou extra fundida, devolve a original — mesma organização e canal, não
 * deletada. Se a original não servir, lança MergedConversationError para o
 * chamador re-resolver uma vez.
 */
export async function writableConversation(
  tx: Prisma.TransactionClient,
  conversationId: string,
  scope: { organizationId: string; channelId: string },
): Promise<WritableConversation> {
  const [row] = await tx.$queryRaw<{ metadata: unknown; status: ConversationStatus }[]>(Prisma.sql`
    SELECT metadata, status FROM conversations WHERE id = ${conversationId} FOR SHARE`);
  const originalId = mergedOriginalId(row?.metadata);
  if (!originalId) {
    return { id: conversationId, status: row?.status ?? null, redirectedFrom: null };
  }
  const original = await tx.conversation.findFirst({
    where: { id: originalId, organizationId: scope.organizationId, channelId: scope.channelId, deletedAt: null },
    select: { id: true, status: true, metadata: true },
  });
  if (!original || mergedOriginalId(original.metadata)) {
    throw new MergedConversationError(conversationId);
  }
  return { id: original.id, status: original.status, redirectedFrom: conversationId };
}
