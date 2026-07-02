import { Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { defaultBaseUrlFor } from '../../ai-agents/providers/provider-defaults';
import { testProviderKey } from './credential-tester';

/**
 * Foco no fix CodeRabbit #1: se o baseUrl NÃO resolve pra um provider não-OpenAI
 * (ex: default ausente pra um provider novo), o teste NÃO pode cair
 * silenciosamente pro endpoint da OpenAI — validaria a chave contra o provider
 * errado. Deve falhar explícito.
 *
 * `defaultBaseUrlFor` é mockado pra simular tanto o caminho feliz quanto o
 * "default ausente".
 */
jest.mock('../../ai-agents/providers/provider-defaults', () => ({
  defaultBaseUrlFor: jest.fn(),
}));

const mockedDefaultBaseUrlFor = defaultBaseUrlFor as jest.MockedFunction<
  typeof defaultBaseUrlFor
>;
const logger = new Logger('test');

describe('credential-tester — missing baseUrl guard', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedDefaultBaseUrlFor.mockReset();
  });

  it('KIMI sem baseUrl e sem default → erro explícito, sem fetch', async () => {
    mockedDefaultBaseUrlFor.mockReturnValue(null);
    const res = await testProviderKey(AiProvider.KIMI, 'sk-kimi', logger, undefined);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Missing base URL configuration for KIMI/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ZAI sem baseUrl e sem default → erro explícito, sem fetch', async () => {
    mockedDefaultBaseUrlFor.mockReturnValue(null);
    const res = await testProviderKey(AiProvider.ZAI, 'sk-zai', logger, undefined);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Missing base URL configuration for ZAI/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('KIMI usa o default resolvido → GET {default}/models com Bearer', async () => {
    mockedDefaultBaseUrlFor.mockReturnValue('https://api.moonshot.ai/v1');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const res = await testProviderKey(AiProvider.KIMI, 'sk-kimi', logger, undefined);
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.moonshot.ai/v1/models');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Bearer sk-kimi',
    );
  });

  it('baseUrl explícito tem precedência sobre o default', async () => {
    mockedDefaultBaseUrlFor.mockReturnValue('https://api.moonshot.ai/v1');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await testProviderKey(AiProvider.KIMI, 'k', logger, 'https://api.moonshot.cn/v1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.moonshot.cn/v1/models');
  });

  it('OPENAI sem baseUrl e sem default → fallback seguro pro endpoint OpenAI', async () => {
    mockedDefaultBaseUrlFor.mockReturnValue(null);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const res = await testProviderKey(AiProvider.OPENAI, 'sk-openai', logger, undefined);
    expect(res.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
  });
});
