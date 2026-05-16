import { Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';

/**
 * Testa uma plaintext API key contra o provider correspondente.
 *
 * Estratégia minimalista — endpoint mais barato e leve possível por provider:
 * - Anthropic: POST /v1/messages com max_tokens=1 (sem count_tokens público estável;
 *   1-token completion custa fração de centavo e valida key+model permission)
 * - OpenAI: GET /v1/models (lista — auth-only, sem custo)
 * - Gemini: GET /v1beta/models?key=... (lista — auth-only, sem custo)
 *
 * Timeout agressivo (8s) pra não travar UI. Retorna `ok` ou `error.message`
 * estruturado (sanitizado — sem echo de key/prompt).
 */
const TIMEOUT_MS = 8000;

export interface TestResult {
  ok: boolean;
  error?: string;
}

export async function testProviderKey(
  provider: AiProvider,
  apiKey: string,
  logger: Logger,
): Promise<TestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    switch (provider) {
      case AiProvider.ANTHROPIC:
        return await testAnthropic(apiKey, controller.signal, logger);
      case AiProvider.OPENAI:
        return await testOpenAI(apiKey, controller.signal, logger);
      case AiProvider.GEMINI:
        return await testGemini(apiKey, controller.signal, logger);
      default:
        return { ok: false, error: `Unknown provider: ${provider}` };
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { ok: false, error: `Timeout after ${TIMEOUT_MS}ms` };
    }
    return { ok: false, error: sanitizeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function testAnthropic(
  apiKey: string,
  signal: AbortSignal,
  logger: Logger,
): Promise<TestResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Invalid API key or insufficient permissions' };
  }
  if (res.status === 429) {
    return { ok: false, error: 'Rate limited — key is valid but throttled' };
  }
  return { ok: false, error: `Anthropic API returned HTTP ${res.status}` };
}

async function testOpenAI(
  apiKey: string,
  signal: AbortSignal,
  logger: Logger,
): Promise<TestResult> {
  const res = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    signal,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.ok) return { ok: true };
  if (res.status === 401) {
    return { ok: false, error: 'Invalid API key' };
  }
  if (res.status === 403) {
    return { ok: false, error: 'Key valid but lacks permission to list models' };
  }
  return { ok: false, error: `OpenAI API returned HTTP ${res.status}` };
}

async function testGemini(
  apiKey: string,
  signal: AbortSignal,
  logger: Logger,
): Promise<TestResult> {
  // Gemini passa key como query param (não Authorization header).
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { method: 'GET', signal });
  if (res.ok) return { ok: true };
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Invalid API key or insufficient permissions' };
  }
  return { ok: false, error: `Gemini API returned HTTP ${res.status}` };
}

/**
 * Remove qualquer eco de header/body que possa ter vazado contexto sensível.
 * Mantém só uma string descritiva curta.
 */
function sanitizeError(err: unknown): string {
  const msg = (err as Error)?.message ?? 'Unknown error';
  // Trunca + remove eventual eco de key/token (heurística defensiva).
  return msg.slice(0, 200).replace(/sk[-_][A-Za-z0-9-]{16,}/g, '[redacted]');
}
