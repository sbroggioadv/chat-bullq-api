import { AiProvider } from '@prisma/client';
import { ProviderResolverService } from './provider-resolver.service';
import type { PrismaService } from '../../../database/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { OrgCredentialsService } from '../../org-credentials/org-credentials.service';
import type { CredentialEventsBus } from '../../org-credentials/credential-events';

/**
 * Foca na resolução de `baseUrl` por provider (feature Kimi/z.ai) e nas env
 * keys dos novos providers. Deps mockadas — sem DB/rede.
 */

function makeResolver(opts: {
  provider: AiProvider;
  orgCred?: { apiKey: string; baseUrl: string | null } | null;
  env?: Record<string, string>;
}) {
  const env = opts.env ?? {};
  const findUnique = jest
    .fn()
    .mockResolvedValue({ providerSelected: opts.provider, modelOverride: null });
  const getDecryptedCredential = jest.fn().mockResolvedValue(opts.orgCred ?? null);
  const configGet = jest.fn((key: string) => env[key]);

  const prisma = {
    organizationCapabilityRouting: { findUnique },
  } as unknown as PrismaService;
  const config = { get: configGet } as unknown as ConfigService;
  const credentials = { getDecryptedCredential } as unknown as OrgCredentialsService;
  const events = { on: jest.fn() } as unknown as CredentialEventsBus;

  return {
    service: new ProviderResolverService(prisma, config, credentials, events),
    getDecryptedCredential,
  };
}

describe('ProviderResolverService — baseUrl resolution', () => {
  it('ORG cred com baseUrl custom → usa o custom (source ORG)', async () => {
    const { service } = makeResolver({
      provider: AiProvider.KIMI,
      orgCred: { apiKey: 'sk-kimi', baseUrl: 'https://api.moonshot.cn/v1' },
    });
    const r = await service.resolveForLlm('org1');
    expect(r.provider).toBe(AiProvider.KIMI);
    expect(r.source).toBe('ORG');
    expect(r.apiKey).toBe('sk-kimi');
    expect(r.baseUrl).toBe('https://api.moonshot.cn/v1');
  });

  it('ORG cred KIMI sem baseUrl → default Moonshot internacional', async () => {
    const { service } = makeResolver({
      provider: AiProvider.KIMI,
      orgCred: { apiKey: 'sk-kimi', baseUrl: null },
    });
    const r = await service.resolveForLlm('org1');
    expect(r.baseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('ORG cred ZAI sem baseUrl → default z.ai v4', async () => {
    const { service } = makeResolver({
      provider: AiProvider.ZAI,
      orgCred: { apiKey: 'sk-zai', baseUrl: null },
    });
    const r = await service.resolveForLlm('org1');
    expect(r.provider).toBe(AiProvider.ZAI);
    expect(r.baseUrl).toBe('https://api.z.ai/api/paas/v4');
  });

  it('sem ORG cred, env KIMI_API_KEY → source ENV + default Moonshot', async () => {
    const { service } = makeResolver({
      provider: AiProvider.KIMI,
      orgCred: null,
      env: { KIMI_API_KEY: 'env-kimi' },
    });
    const r = await service.resolveForLlm('org1');
    expect(r.source).toBe('ENV');
    expect(r.apiKey).toBe('env-kimi');
    expect(r.baseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('env alias MOONSHOT_API_KEY também resolve KIMI', async () => {
    const { service } = makeResolver({
      provider: AiProvider.KIMI,
      orgCred: null,
      env: { MOONSHOT_API_KEY: 'env-moonshot' },
    });
    const r = await service.resolveForLlm('org1');
    expect(r.source).toBe('ENV');
    expect(r.apiKey).toBe('env-moonshot');
  });

  it('env KIMI_BASE_URL sobrescreve o default no path ENV', async () => {
    const { service } = makeResolver({
      provider: AiProvider.KIMI,
      orgCred: null,
      env: { KIMI_API_KEY: 'env-kimi', KIMI_BASE_URL: 'https://proxy.internal/v1' },
    });
    const r = await service.resolveForLlm('org1');
    expect(r.baseUrl).toBe('https://proxy.internal/v1');
  });

  it('env ZAI_API_KEY → source ENV + default z.ai', async () => {
    const { service } = makeResolver({
      provider: AiProvider.ZAI,
      orgCred: null,
      env: { ZAI_API_KEY: 'env-zai' },
    });
    const r = await service.resolveForLlm('org1');
    expect(r.source).toBe('ENV');
    expect(r.apiKey).toBe('env-zai');
    expect(r.baseUrl).toBe('https://api.z.ai/api/paas/v4');
  });

  it('OPENAI env → baseUrl default OpenAI', async () => {
    const { service } = makeResolver({
      provider: AiProvider.OPENAI,
      orgCred: null,
      env: { OPENAI_API_KEY: 'sk-openai' },
    });
    const r = await service.resolveForLlm('org1');
    expect(r.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('ANTHROPIC (não OpenAI-compat) → baseUrl null mesmo com key', async () => {
    const { service } = makeResolver({
      provider: AiProvider.ANTHROPIC,
      orgCred: null,
      env: { ANTHROPIC_API_KEY: 'sk-ant' },
    });
    const r = await service.resolveForLlm('org1');
    expect(r.source).toBe('ENV');
    expect(r.baseUrl).toBeNull();
  });

  it('sem cred e sem env → source NONE, apiKey e baseUrl null', async () => {
    const { service } = makeResolver({
      provider: AiProvider.KIMI,
      orgCred: null,
      env: {},
    });
    const r = await service.resolveForLlm('org1');
    expect(r.source).toBe('NONE');
    expect(r.apiKey).toBeNull();
    expect(r.baseUrl).toBeNull();
  });
});
