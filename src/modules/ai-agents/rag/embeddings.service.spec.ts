import { AiProvider } from '@prisma/client';
import { EmbeddingsService } from './embeddings.service';

describe('EmbeddingsService OpenAI-compat', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  it('chama {baseUrl}/embeddings da Sakana com a chave Fugu', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
        usage: { total_tokens: 4 },
      }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const resolver = {
      resolveForEmbeddings: jest.fn(async () => ({
        provider: AiProvider.FUGU,
        apiKey: 'sakana-key',
        source: 'ORG',
        modelOverride: 'text-embedding-3-small',
        baseUrl: 'https://api.sakana.ai/v1',
      })),
    };
    const svc = new EmbeddingsService({ get: () => undefined } as any, resolver as any);
    const out = await svc.embed('honorários 20%', 'org1');
    expect(out.vector).toEqual([0.1, 0.2]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sakana.ai/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sakana-key',
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body).model).toBe('text-embedding-3-small');
  });
});
