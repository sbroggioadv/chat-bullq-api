import { AiProvider } from '@prisma/client';
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMessage,
  LlmUsage,
} from '../llm/llm.types';

/**
 * Contrato comum pra todos os providers de LLM. LlmService delega pra
 * implementação concreta (Anthropic/OpenAI/Gemini) decidida pelo
 * ProviderResolverService.
 */
export interface LlmAdapter {
  readonly provider: AiProvider;
  complete(
    req: LlmCompletionRequest,
    apiKey: string,
  ): Promise<LlmCompletionResponse>;
}

/**
 * Helper compartilhado pra normalizar usage zerado quando o adapter não
 * retorna campo (Gemini não dá cache tokens, etc).
 */
export function zeroUsage(): LlmUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

/**
 * Extrai texto plain de LlmMessage.content (suporta string ou parts).
 * Não inclui imagens (OpenAI/Gemini precisam de transformação específica
 * pra suporte multimodal — fora do escopo da W2).
 */
export function extractText(message: LlmMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
