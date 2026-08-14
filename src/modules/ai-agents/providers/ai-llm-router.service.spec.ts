import { AiProvider } from '@prisma/client';
import { AiLlmRouterService } from './ai-llm-router.service';
import { FuguLlmAdapter } from './fugu-llm.adapter';
import { QwenLlmAdapter } from './qwen-llm.adapter';

const OK = {
  stopReason: 'stop' as const,
  message: { role: 'assistant' as const, content: 'ok' },
};

function build(opts: {
  resolveProvider: jest.Mock;
  fugu?: jest.Mock;
  qwen?: jest.Mock;
  zai?: jest.Mock;
}) {
  const resolver = {
    resolveForLlm: jest.fn(),
    resolveProvider: opts.resolveProvider,
  };
  const fugu = { complete: opts.fugu ?? jest.fn().mockResolvedValue(OK) };
  const qwen = { complete: opts.qwen ?? jest.fn().mockResolvedValue(OK) };
  const zai = { complete: opts.zai ?? jest.fn().mockResolvedValue(OK) };
  const svc = new AiLlmRouterService(
    resolver as never,
    { complete: jest.fn() } as never,
    { complete: jest.fn() } as never,
    { complete: jest.fn() } as never,
    { complete: jest.fn() } as never,
    zai as never,
    fugu as never,
    qwen as never,
  );
  return { svc, resolver, fugu, qwen, zai };
}

const REQ = {
  organizationId: 'org1',
  modelId: 'glm-5.2',
  messages: [{ role: 'user' as const, content: 'oi' }],
};

describe('AiLlmRouterService.completeAttendance', () => {
  it('usa Fugu e nunca consulta routing nem ZAI', async () => {
    const { svc, resolver, fugu, qwen, zai } = build({
      resolveProvider: jest.fn().mockResolvedValue({
        provider: AiProvider.FUGU,
        apiKey: 'sk-fugu',
        source: 'ORG',
        modelOverride: null,
        baseUrl: 'https://api.sakana.ai/v1',
      }),
    });

    await svc.completeAttendance(REQ);

    expect(resolver.resolveForLlm).not.toHaveBeenCalled();
    expect(resolver.resolveProvider).toHaveBeenCalledWith('org1', AiProvider.FUGU);
    expect(fugu.complete).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: FuguLlmAdapter.DEFAULT_MODEL }),
      'sk-fugu',
      'https://api.sakana.ai/v1',
    );
    expect(qwen.complete).not.toHaveBeenCalled();
    expect(zai.complete).not.toHaveBeenCalled();
  });

  it('cai em Qwen quando Fugu não tem credencial', async () => {
    const { svc, fugu, qwen } = build({
      resolveProvider: jest
        .fn()
        .mockResolvedValueOnce({
          provider: AiProvider.FUGU,
          apiKey: null,
          source: 'NONE',
        })
        .mockResolvedValueOnce({
          provider: AiProvider.QWEN,
          apiKey: 'sk-qwen',
          source: 'ORG',
          modelOverride: null,
          baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        }),
    });

    await svc.completeAttendance(REQ);

    expect(fugu.complete).not.toHaveBeenCalled();
    expect(qwen.complete).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: QwenLlmAdapter.DEFAULT_MODEL }),
      'sk-qwen',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('cai em Qwen quando Fugu lança', async () => {
    const { svc, qwen } = build({
      resolveProvider: jest
        .fn()
        .mockResolvedValueOnce({
          provider: AiProvider.FUGU,
          apiKey: 'sk-fugu',
          source: 'ORG',
          baseUrl: 'https://api.sakana.ai/v1',
        })
        .mockResolvedValueOnce({
          provider: AiProvider.QWEN,
          apiKey: 'sk-qwen',
          source: 'ORG',
          baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        }),
      fugu: jest.fn().mockRejectedValue(new Error('HTTP 429 Insufficient balance')),
    });

    await svc.completeAttendance(REQ);

    expect(qwen.complete).toHaveBeenCalled();
  });

  it('falha quando Fugu e Qwen estão sem credencial', async () => {
    const { svc } = build({
      resolveProvider: jest.fn().mockResolvedValue({
        apiKey: null,
        source: 'NONE',
      }),
    });

    await expect(svc.completeAttendance(REQ)).rejects.toThrow(
      /Fugu then Qwen/,
    );
  });
});
