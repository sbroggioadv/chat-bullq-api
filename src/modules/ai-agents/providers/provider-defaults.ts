import { AiProvider } from '@prisma/client';

/**
 * Base URL default por provider OpenAI-compatible, usado quando a org NÃO
 * configurou um baseUrl custom em `OrganizationCredential.baseUrl`.
 *
 * Fontes (confirmadas via context7 / docs oficiais, jul/2026):
 *   - OpenAI:  https://api.openai.com/v1
 *   - Kimi/Moonshot (internacional): https://api.moonshot.ai/v1
 *       Bearer direto. Endpoint China doméstico: https://api.moonshot.cn/v1
 *       (usar via baseUrl custom por credencial).
 *   - z.ai/Zhipu (internacional): https://api.z.ai/api/paas/v4
 *       Aceita a API key como Bearer direto — o JWT do SDK `zhipuai` legado
 *       NÃO é necessário. Endpoint China: https://open.bigmodel.cn/api/paas/v4
 *       (usar via baseUrl custom por credencial).
 *
 * Providers que NÃO são OpenAI-compatible (ANTHROPIC, GEMINI) não têm entrada
 * aqui — usam URL própria hardcoded no seu adapter.
 */
export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL: Partial<Record<AiProvider, string>> = {
  [AiProvider.OPENAI]: 'https://api.openai.com/v1',
  [AiProvider.KIMI]: 'https://api.moonshot.ai/v1',
  [AiProvider.ZAI]: 'https://api.z.ai/api/paas/v4',
};

/**
 * Retorna a base URL default do provider, ou `null` quando o provider não é
 * OpenAI-compatible (Anthropic/Gemini) — nesse caso baseUrl não se aplica.
 */
export function defaultBaseUrlFor(provider: AiProvider): string | null {
  return OPENAI_COMPATIBLE_DEFAULT_BASE_URL[provider] ?? null;
}
