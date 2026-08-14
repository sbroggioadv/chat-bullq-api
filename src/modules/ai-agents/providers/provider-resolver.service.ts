import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiCapability, AiProvider } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CredentialEventsBus } from '../../org-credentials/credential-events';
import { OrgCredentialsService } from '../../org-credentials/org-credentials.service';
import { defaultBaseUrlFor } from './provider-defaults';
import { isAllowedProviderBaseUrl } from './provider-baseurl-guard';

/**
 * Source enum: identifica origem da credential resolvida pra observability/audit.
 * - ORG: organização configurou a key via /settings/ai-credentials
 * - ENV: caiu pro fallback global do servidor (compat com pre-W2)
 * - NONE: nem org nem env tem key — caller deve falhar gracioso
 */
export type ResolvedSource = 'ORG' | 'ENV' | 'NONE';

export interface ResolvedCredential {
  provider: AiProvider;
  apiKey: string | null; // null quando source=NONE
  source: ResolvedSource;
  modelOverride?: string | null;
  /**
   * Base URL efetiva pra providers OpenAI-compatible (OpenAI/Kimi/z.ai).
   * `null` quando o provider não é OpenAI-compatible (Anthropic/Gemini) ou
   * quando não há key resolvida. Precedência: credencial custom → env override
   * → default do provider.
   */
  baseUrl?: string | null;
}

interface CacheEntry {
  apiKey: string;
  baseUrl: string | null;
  expiresAt: number;
}

/**
 * Resolve qual API key usar pra cada combinação (org, capability).
 *
 * Algoritmo (per call):
 *   1. Lê OrganizationCapabilityRouting[orgId][capability] → providerSelected
 *   2. Lê OrganizationCredential[orgId][providerSelected] → encryptedKey
 *   3. Decifra e cacheia (60s TTL, key invalidada via CredentialEventsBus)
 *   4. Se org não tem credential, fallback pra env (ANTHROPIC_API_KEY etc)
 *   5. Se env também ausente, source='NONE' (caller decide se segue ou erra)
 *
 * Cache: ~30 orgs × 3 providers = 90 entries max em prática. Map simples.
 */
@Injectable()
export class ProviderResolverService implements OnModuleInit {
  private readonly logger = new Logger(ProviderResolverService.name);
  private static readonly CACHE_TTL_MS = 60_000;

  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly credentials: OrgCredentialsService,
    private readonly events: CredentialEventsBus,
  ) {}

  onModuleInit(): void {
    // Invalida cache de uma (org, provider) específica quando muda.
    this.events.on(({ organizationId, provider }) => {
      const key = this.cacheKey(organizationId, provider);
      this.cache.delete(key);
    });
  }

  async resolveForLlm(organizationId: string): Promise<ResolvedCredential> {
    return this.resolveByCapability(organizationId, AiCapability.LLM_AGENT);
  }

  /** Resolve a credential for a specific provider (org then env), ignoring routing. */
  async resolveProvider(
    organizationId: string,
    provider: AiProvider,
  ): Promise<ResolvedCredential> {
    return this.lookupCredential(organizationId, provider, null);
  }

  async resolveForTranscription(organizationId: string): Promise<ResolvedCredential> {
    return this.resolveByCapability(organizationId, AiCapability.TRANSCRIPTION);
  }

  async resolveForEmbeddings(organizationId: string): Promise<ResolvedCredential> {
    return this.resolveByCapability(organizationId, AiCapability.EMBEDDINGS);
  }

  private async resolveByCapability(
    organizationId: string,
    capability: AiCapability,
  ): Promise<ResolvedCredential> {
    // 1. Lê routing
    const routing = await this.prisma.organizationCapabilityRouting.findUnique({
      where: { organizationId_capability: { organizationId, capability } },
    });
    const provider = routing?.providerSelected ?? this.defaultProvider(capability);
    const modelOverride = routing?.modelOverride ?? null;
    return this.lookupCredential(organizationId, provider, modelOverride, capability);
  }

  private async lookupCredential(
    organizationId: string,
    provider: AiProvider,
    modelOverride: string | null,
    capability?: AiCapability,
  ): Promise<ResolvedCredential> {
    const cacheKey = this.cacheKey(organizationId, provider);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        provider,
        apiKey: cached.apiKey,
        source: 'ORG',
        modelOverride,
        baseUrl: cached.baseUrl,
      };
    }

    const orgCred = await this.credentials.getDecryptedCredential(
      organizationId,
      provider,
    );
    if (orgCred) {
      const baseUrl = this.assertSafeBaseUrl(
        provider,
        orgCred.baseUrl ?? this.defaultBaseUrl(provider),
      );
      this.cache.set(cacheKey, {
        apiKey: orgCred.apiKey,
        baseUrl,
        expiresAt: Date.now() + ProviderResolverService.CACHE_TTL_MS,
      });
      return { provider, apiKey: orgCred.apiKey, source: 'ORG', modelOverride, baseUrl };
    }

    const envKey = this.envKeyFor(provider);
    if (envKey) {
      const baseUrl = this.assertSafeBaseUrl(
        provider,
        this.envBaseUrl(provider) ?? this.defaultBaseUrl(provider),
      );
      return { provider, apiKey: envKey, source: 'ENV', modelOverride, baseUrl };
    }

    this.logger.warn(
      `No credential found for org=${organizationId} capability=${capability ?? 'direct'} provider=${provider} (org and env both empty)`,
    );
    return { provider, apiKey: null, source: 'NONE', modelOverride, baseUrl: null };
  }

  private envKeyFor(provider: AiProvider): string | null {
    switch (provider) {
      case AiProvider.ANTHROPIC:
        return (
          this.config.get<string>('ANTHROPIC_API_KEY') ??
          process.env.ANTHROPIC_API_KEY ??
          null
        );
      case AiProvider.OPENAI:
        return (
          this.config.get<string>('OPENAI_API_KEY') ??
          process.env.OPENAI_API_KEY ??
          null
        );
      case AiProvider.GEMINI:
        return (
          this.config.get<string>('GEMINI_API_KEY') ??
          process.env.GEMINI_API_KEY ??
          null
        );
      case AiProvider.KIMI:
        // Aceita KIMI_API_KEY ou o alias MOONSHOT_API_KEY.
        return (
          this.config.get<string>('KIMI_API_KEY') ??
          process.env.KIMI_API_KEY ??
          this.config.get<string>('MOONSHOT_API_KEY') ??
          process.env.MOONSHOT_API_KEY ??
          null
        );
      case AiProvider.ZAI:
        // Aceita ZAI_API_KEY ou o alias ZHIPU_API_KEY.
        return (
          this.config.get<string>('ZAI_API_KEY') ??
          process.env.ZAI_API_KEY ??
          this.config.get<string>('ZHIPU_API_KEY') ??
          process.env.ZHIPU_API_KEY ??
          null
        );
      case AiProvider.FUGU:
        return (
          this.config.get<string>('FUGU_API_KEY') ??
          process.env.FUGU_API_KEY ??
          this.config.get<string>('SAKANA_API_KEY') ??
          process.env.SAKANA_API_KEY ??
          null
        );
      case AiProvider.QWEN:
        return (
          this.config.get<string>('QWEN_API_KEY') ??
          process.env.QWEN_API_KEY ??
          this.config.get<string>('DASHSCOPE_API_KEY') ??
          process.env.DASHSCOPE_API_KEY ??
          null
        );
      default:
        return null;
    }
  }

  /**
   * Base URL default do provider (OpenAI/Kimi/z.ai). `null` pra providers que
   * não são OpenAI-compatible — nesse caso o adapter usa URL própria.
   */
  private defaultBaseUrl(provider: AiProvider): string | null {
    return defaultBaseUrlFor(provider);
  }

  /**
   * SSRF fail-closed: valida o baseUrl resolvido contra a allowlist ANTES de
   * devolvê-lo (o router/adapter fará fetch autenticado nele). Defaults são
   * sempre allowlisted; só um baseUrl custom/env inválido dispara o throw —
   * assim nenhuma request é feita a um host proibido, mesmo com dado legado.
   */
  private assertSafeBaseUrl(
    provider: AiProvider,
    baseUrl: string | null,
  ): string | null {
    if (baseUrl && !isAllowedProviderBaseUrl(baseUrl)) {
      this.logger.error(
        `Blocked disallowed provider baseUrl for provider=${provider} (SSRF guard)`,
      );
      throw new InternalServerErrorException(
        'Configured provider baseUrl is not allowed',
      );
    }
    return baseUrl;
  }

  /**
   * Override de base URL via env (útil pra endpoints regionais/self-hosted sem
   * precisar de credencial org-level). Ex: `KIMI_BASE_URL` apontando pro
   * endpoint China. `null` = sem override.
   */
  private envBaseUrl(provider: AiProvider): string | null {
    switch (provider) {
      case AiProvider.OPENAI:
        return (
          this.config.get<string>('OPENAI_BASE_URL') ??
          process.env.OPENAI_BASE_URL ??
          null
        );
      case AiProvider.KIMI:
        return (
          this.config.get<string>('KIMI_BASE_URL') ??
          process.env.KIMI_BASE_URL ??
          this.config.get<string>('MOONSHOT_BASE_URL') ??
          process.env.MOONSHOT_BASE_URL ??
          null
        );
      case AiProvider.ZAI:
        return (
          this.config.get<string>('ZAI_BASE_URL') ??
          process.env.ZAI_BASE_URL ??
          this.config.get<string>('ZHIPU_BASE_URL') ??
          process.env.ZHIPU_BASE_URL ??
          null
        );
      case AiProvider.FUGU:
        return (
          this.config.get<string>('FUGU_BASE_URL') ??
          process.env.FUGU_BASE_URL ??
          this.config.get<string>('SAKANA_BASE_URL') ??
          process.env.SAKANA_BASE_URL ??
          null
        );
      case AiProvider.QWEN:
        return (
          this.config.get<string>('QWEN_BASE_URL') ??
          process.env.QWEN_BASE_URL ??
          this.config.get<string>('DASHSCOPE_BASE_URL') ??
          process.env.DASHSCOPE_BASE_URL ??
          null
        );
      default:
        return null;
    }
  }

  private defaultProvider(capability: AiCapability): AiProvider {
    switch (capability) {
      case AiCapability.LLM_AGENT:
        return AiProvider.FUGU;
      case AiCapability.TRANSCRIPTION:
        return AiProvider.OPENAI;
      case AiCapability.EMBEDDINGS:
        return AiProvider.FUGU;
    }
  }

  private cacheKey(organizationId: string, provider: AiProvider): string {
    return `${organizationId}:${provider}`;
  }

  /** Test helper — força clear do cache (uso em e2e). */
  clearCache(): void {
    this.cache.clear();
  }
}
