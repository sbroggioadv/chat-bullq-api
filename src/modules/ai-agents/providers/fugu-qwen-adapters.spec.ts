import { AiProvider } from '@prisma/client';
import { FuguLlmAdapter } from './fugu-llm.adapter';
import { QwenLlmAdapter } from './qwen-llm.adapter';
import type {
  OpenAiCompatibleAdapter,
  OpenAiCompatibleConfig,
} from './openai-compatible.adapter';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';

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

describe('FuguLlmAdapter', () => {
  it('expõe provider FUGU', () => {
    const { compat } = makeCompat();
    expect(new FuguLlmAdapter(compat).provider).toBe(AiProvider.FUGU);
  });

  it('delega com base URL Sakana e modelo default fugu-ultra, sem temperature', async () => {
    const { compat, lastCfg } = makeCompat();
    await new FuguLlmAdapter(compat).complete(req('fugu-ultra'), 'sk-fugu');
    const cfg = lastCfg();
    expect(cfg.baseUrl).toBe('https://api.sakana.ai/v1');
    expect(cfg.providerLabel).toBe('Sakana Fugu');
    expect(cfg.defaultModel).toBe('fugu-ultra');
    expect(cfg.omitTemperature).toBe(true);
  });

  it('respeita baseUrl custom', async () => {
    const { compat, lastCfg } = makeCompat();
    await new FuguLlmAdapter(compat).complete(
      req('fugu-ultra'),
      'k',
      'https://api.sakana.ai/v1',
    );
    expect(lastCfg().baseUrl).toBe('https://api.sakana.ai/v1');
  });

  it('normalizeModelId: strip sakana/, passthrough fugu-ultra*, fallback estrangeiro', async () => {
    const { compat, lastCfg } = makeCompat();
    await new FuguLlmAdapter(compat).complete(req('x'), 'k');
    const norm = lastCfg().normalizeModelId;
    expect(norm('sakana/fugu-ultra')).toBe('fugu-ultra');
    expect(norm('fugu-ultra-v1.1')).toBe('fugu-ultra-v1.1');
    expect(norm('gpt-4o')).toBe('fugu-ultra');
    expect(norm('qwen3.7-max')).toBe('fugu-ultra');
  });
});

describe('QwenLlmAdapter', () => {
  it('expõe provider QWEN', () => {
    const { compat } = makeCompat();
    expect(new QwenLlmAdapter(compat).provider).toBe(AiProvider.QWEN);
  });

  it('delega com base URL DashScope intl e modelo default qwen3.7-max', async () => {
    const { compat, lastCfg } = makeCompat();
    await new QwenLlmAdapter(compat).complete(req('qwen3.7-max'), 'sk-qwen');
    const cfg = lastCfg();
    expect(cfg.baseUrl).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
    expect(cfg.providerLabel).toBe('Qwen');
    expect(cfg.defaultModel).toBe('qwen3.7-max');
  });

  it('respeita baseUrl custom (China)', async () => {
    const { compat, lastCfg } = makeCompat();
    await new QwenLlmAdapter(compat).complete(
      req('qwen3.7-max'),
      'k',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(lastCfg().baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  it('normalizeModelId: aliases e strip prefixo, fallback estrangeiro', async () => {
    const { compat, lastCfg } = makeCompat();
    await new QwenLlmAdapter(compat).complete(req('x'), 'k');
    const norm = lastCfg().normalizeModelId;
    expect(norm('qwen/qwen3.7-max')).toBe('qwen3.7-max');
    expect(norm('qwen-3.7-max')).toBe('qwen3.7-max');
    expect(norm('qwen3-max')).toBe('qwen3.7-max');
    expect(norm('claude-3-5')).toBe('qwen3.7-max');
    expect(norm('qwen-plus')).toBe('qwen-plus');
  });
});
