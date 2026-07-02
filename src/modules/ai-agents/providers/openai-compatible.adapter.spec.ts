import { InternalServerErrorException } from '@nestjs/common';
import { OpenAiCompatibleAdapter, OpenAiCompatibleConfig } from './openai-compatible.adapter';
import type { LlmCompletionRequest } from '../llm/llm.types';

/**
 * Testes do adapter OpenAI-compatible compartilhado (usado por OpenAI, Kimi,
 * z.ai). Mock do `fetch` global — nenhuma chamada de rede real.
 */

interface FakeRes {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function fakeResponse(
  body: unknown,
  opts: { ok?: boolean; status?: number; text?: string } = {},
): FakeRes {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
    text: async () => opts.text ?? JSON.stringify(body),
  };
}

const baseCfg: OpenAiCompatibleConfig = {
  baseUrl: 'https://api.example.com/v1',
  providerLabel: 'Example',
  defaultModel: 'model-default',
  normalizeModelId: (id) => id,
  costTable: {
    'model-a': { in: 1 / 1e6, out: 2 / 1e6 },
    'model-default': { in: 0, out: 0 },
  },
};

const req = (over: Partial<LlmCompletionRequest> = {}): LlmCompletionRequest => ({
  modelId: 'model-a',
  messages: [{ role: 'user', content: 'oi' }],
  ...over,
});

describe('OpenAiCompatibleAdapter', () => {
  let adapter: OpenAiCompatibleAdapter;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    adapter = new OpenAiCompatibleAdapter();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('faz POST em {baseUrl}/chat/completions com Bearer e retorna texto', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        model: 'model-a',
        choices: [{ message: { role: 'assistant', content: 'olá' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );

    const out = await adapter.complete(req(), 'sk-test-key', baseCfg);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test-key');
    expect(out.message.content).toBe('olá');
    expect(out.stopReason).toBe('stop');
    expect(out.usage.inputTokens).toBe(10);
    expect(out.usage.outputTokens).toBe(5);
    // cost = 10*1e-6 + 5*2e-6
    expect(out.usage.costUsd).toBeCloseTo(10 / 1e6 + (5 * 2) / 1e6, 12);
    expect(out.rawModelId).toBe('model-a');
  });

  it('remove trailing slash da baseUrl antes de compor a URL', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
      }),
    );
    await adapter.complete(req(), 'k', { ...baseCfg, baseUrl: 'https://api.example.com/v1///' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
  });

  it('mapeia tool_calls e marca stopReason tool_calls', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        model: 'model-a',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'buscar', arguments: '{"q":"cnj"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    );

    const out = await adapter.complete(req(), 'k', baseCfg);
    expect(out.stopReason).toBe('tool_calls');
    expect(out.message.toolCalls).toEqual([
      { id: 'call_1', name: 'buscar', arguments: { q: 'cnj' } },
    ]);
  });

  it('envia tools no formato function quando req.tools presente', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    await adapter.complete(
      req({
        tools: [{ name: 'buscar', description: 'busca', parameters: { type: 'object' } }],
      }),
      'k',
      baseCfg,
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'buscar', description: 'busca', parameters: { type: 'object' } },
      },
    ]);
    // NÃO deve injetar tool_choice nem functions (compat Kimi).
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('functions');
  });

  it('aplica normalizeModelId da config no campo model', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    await adapter.complete(req({ modelId: 'claude-3' }), 'k', {
      ...baseCfg,
      normalizeModelId: () => 'model-default',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('model-default');
  });

  it('lança InternalServerErrorException com label do provider em erro HTTP', async () => {
    // Persistente (não -Once): as duas asserções abaixo disparam uma chamada cada.
    fetchMock.mockResolvedValue(
      fakeResponse(
        {},
        { ok: false, status: 401, text: JSON.stringify({ error: { message: 'bad key' } }) },
      ),
    );
    await expect(adapter.complete(req(), 'k', baseCfg)).rejects.toThrow(
      InternalServerErrorException,
    );
    await expect(adapter.complete(req(), 'k', baseCfg)).rejects.toThrow(/Example API returned 401/);
  });

  it('lança quando não há choices na resposta', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ choices: [] }));
    await expect(adapter.complete(req(), 'k', baseCfg)).rejects.toThrow(/Example returned no choices/);
  });
});
