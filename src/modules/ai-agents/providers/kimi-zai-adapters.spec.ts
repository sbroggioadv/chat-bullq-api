import { AiProvider } from '@prisma/client';
import { KimiLlmAdapter } from './kimi-llm.adapter';
import { ZaiLlmAdapter } from './zai-llm.adapter';
import type {
  OpenAiCompatibleAdapter,
  OpenAiCompatibleConfig,
} from './openai-compatible.adapter';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';

/**
 * Kimi (Moonshot) e z.ai (Zhipu/GLM) são cascas finas sobre o
 * OpenAiCompatibleAdapter. Aqui validamos que cada um delega com a config
 * correta: base URL default, modelo fallback e normalização de model id.
 */

const fakeCompletion: LlmCompletionResponse = {
  message: { role: 'assistant', content: 'ok' },
  stopReason: 'stop',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  rawModelId: 'x',
};

const req = (modelId: string): LlmCompletionRequest => ({
  modelId,
  messages: [{ role: 'user', content: 'oi' }],
});

function makeCompat() {
  const complete = jest.fn().mockResolvedValue(fakeCompletion);
  const compat = { complete } as unknown as OpenAiCompatibleAdapter;
  const lastCfg = (): OpenAiCompatibleConfig => complete.mock.calls.at(-1)![2];
  return { compat, complete, lastCfg };
}

describe('KimiLlmAdapter', () => {
  it('expõe provider KIMI', () => {
    const { compat } = makeCompat();
    expect(new KimiLlmAdapter(compat).provider).toBe(AiProvider.KIMI);
  });

  it('delega com base URL default da Moonshot e modelo default kimi-k2.6', async () => {
    const { compat, complete, lastCfg } = makeCompat();
    const adapter = new KimiLlmAdapter(compat);
    await adapter.complete(req('kimi-k2.6'), 'sk-kimi');
    expect(complete).toHaveBeenCalledWith(expect.anything(), 'sk-kimi', expect.anything());
    const cfg = lastCfg();
    expect(cfg.baseUrl).toBe('https://api.moonshot.ai/v1');
    expect(cfg.providerLabel).toBe('Kimi');
    expect(cfg.defaultModel).toBe('kimi-k2.6');
  });

  it('respeita baseUrl custom (endpoint China)', async () => {
    const { compat, lastCfg } = makeCompat();
    await new KimiLlmAdapter(compat).complete(req('kimi-k2.6'), 'k', 'https://api.moonshot.cn/v1');
    expect(lastCfg().baseUrl).toBe('https://api.moonshot.cn/v1');
  });

  it('normalizeModelId: strip prefixo, fallback em model estrangeiro, passthrough válido', async () => {
    const { compat, lastCfg } = makeCompat();
    await new KimiLlmAdapter(compat).complete(req('x'), 'k');
    const norm = lastCfg().normalizeModelId;
    expect(norm('kimi/kimi-k2.5')).toBe('kimi-k2.5');
    expect(norm('moonshot/moonshot-v1-128k')).toBe('moonshot-v1-128k');
    expect(norm('claude-3-5')).toBe('kimi-k2.6');
    expect(norm('gpt-4o')).toBe('kimi-k2.6');
    expect(norm('kimi-k2.6')).toBe('kimi-k2.6');
    expect(norm('moonshot-v1-32k')).toBe('moonshot-v1-32k');
  });
});

describe('ZaiLlmAdapter', () => {
  it('expõe provider ZAI', () => {
    const { compat } = makeCompat();
    expect(new ZaiLlmAdapter(compat).provider).toBe(AiProvider.ZAI);
  });

  it('delega com base URL default z.ai v4 e modelo default glm-5.2', async () => {
    const { compat, lastCfg } = makeCompat();
    await new ZaiLlmAdapter(compat).complete(req('glm-5.2'), 'sk-zai');
    const cfg = lastCfg();
    expect(cfg.baseUrl).toBe('https://api.z.ai/api/paas/v4');
    expect(cfg.providerLabel).toBe('z.ai');
    expect(cfg.defaultModel).toBe('glm-5.2');
  });

  it('respeita baseUrl custom (endpoint bigmodel.cn)', async () => {
    const { compat, lastCfg } = makeCompat();
    await new ZaiLlmAdapter(compat).complete(
      req('glm-4.6'),
      'k',
      'https://open.bigmodel.cn/api/paas/v4',
    );
    expect(lastCfg().baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('normalizeModelId: strip prefixo, fallback em model estrangeiro, passthrough GLM', async () => {
    const { compat, lastCfg } = makeCompat();
    await new ZaiLlmAdapter(compat).complete(req('x'), 'k');
    const norm = lastCfg().normalizeModelId;
    expect(norm('zai/glm-4.5-air')).toBe('glm-4.5-air');
    expect(norm('zhipu/glm-4.6')).toBe('glm-4.6');
    expect(norm('anthropic/claude-sonnet-4-6')).toBe('glm-5.2');
    expect(norm('claude-3-5')).toBe('glm-5.2');
    expect(norm('kimi-k2.6')).toBe('glm-5.2');
    expect(norm('glm-4.6')).toBe('glm-4.6');
  });
});
