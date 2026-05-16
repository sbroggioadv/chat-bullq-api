/**
 * Canonical model IDs — atualizadas mensalmente (lição S18/Wave 4).
 *
 * Anthropic retira IDs antigos periodicamente (vide bug 2026-05-16: o test
 * endpoint usava `claude-3-5-haiku-20241022` deprecated e retornava 404).
 * Centralizar aqui evita drift entre callers (test endpoint, reranker default,
 * classifier default, memory extractor, etc).
 *
 * Quando um modelo nova versão sair:
 *   1. Atualizar a const correspondente (`LATEST_HAIKU` → novo ID).
 *   2. Rodar `grep -rn 'claude-' src/` pra encontrar hardcodes que escaparam.
 *   3. Atualizar comentários de docstring (use `@see LATEST_MODELS` ao invés
 *      de citar o ID literal).
 *
 * Os IDs aqui são canônicos da Anthropic SDK (`claude-sonnet-4-6`, etc).
 * Quando precisar do prefixo "anthropic/" pra router agnóstico, use o
 * helper `withProviderPrefix(LATEST_HAIKU)`.
 */

export const LATEST_MODELS = {
  /** Haiku — barato, rápido, ideal pra classificação, judge, reranker. */
  HAIKU: 'claude-haiku-4-5',
  /** Sonnet — balanceado, AI Agents principal. */
  SONNET: 'claude-sonnet-4-6',
  /** Opus — top-tier, raramente necessário em prod. */
  OPUS: 'claude-opus-4-7',
} as const;

/**
 * Lista provider-prefixed para callers que usam router agnóstico
 * (ex.: RAG reranker espera `anthropic/<id>`).
 */
export const LATEST_MODELS_PREFIXED = {
  HAIKU: `anthropic/${LATEST_MODELS.HAIKU}`,
  SONNET: `anthropic/${LATEST_MODELS.SONNET}`,
  OPUS: `anthropic/${LATEST_MODELS.OPUS}`,
} as const;

/**
 * Helper pra adicionar prefix em runtime se caller tem o ID puro mas
 * precisa do formato router (`anthropic/<id>`).
 */
export function withProviderPrefix(
  modelId: string,
  provider: 'anthropic' | 'openai' | 'gemini' = 'anthropic',
): string {
  if (modelId.includes('/')) return modelId; // já tem prefix
  return `${provider}/${modelId}`;
}
