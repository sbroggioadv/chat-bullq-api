import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';
import { OpenAiLlmAdapter } from './openai-llm.adapter';
import { GeminiLlmAdapter } from './gemini-llm.adapter';
import { KimiLlmAdapter } from './kimi-llm.adapter';
import { ZaiLlmAdapter } from './zai-llm.adapter';
import { ProviderResolverService } from './provider-resolver.service';

/**
 * Entry-point unificado pra completion LLM.
 *
 * Caller passa `LlmCompletionRequest` com `organizationId` setado; router
 * resolve provider + apiKey via ProviderResolverService e despacha pro
 * adapter certo.
 *
 * Compat: chamadas sem `organizationId` (ex: chamadas internas tipo
 * memory-extractor, judge, classifier) continuam funcionando — caem no
 * provider Anthropic com key de env (comportamento pré-S18/W2).
 */
@Injectable()
export class AiLlmRouterService {
  private readonly logger = new Logger(AiLlmRouterService.name);

  constructor(
    private readonly resolver: ProviderResolverService,
    private readonly anthropic: LlmService,
    private readonly openai: OpenAiLlmAdapter,
    private readonly gemini: GeminiLlmAdapter,
    private readonly kimi: KimiLlmAdapter,
    private readonly zai: ZaiLlmAdapter,
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (!req.organizationId) {
      // Compat path — caller não setou orgId. Usa Anthropic env-based.
      return this.anthropic.complete(req);
    }

    const resolved = await this.resolver.resolveForLlm(req.organizationId);

    if (resolved.source === 'NONE') {
      throw new InternalServerErrorException(
        `No LLM credential available for org=${req.organizationId} (neither org-level nor env). Configure ZAI_API_KEY, ZHIPU_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY env, or set org credential at /settings/ai-credentials`,
      );
    }

    // Override modelId se o routing tiver modelOverride configurado.
    const effectiveReq: LlmCompletionRequest = resolved.modelOverride
      ? { ...req, modelId: resolved.modelOverride }
      : req;

    switch (resolved.provider) {
      case AiProvider.ANTHROPIC:
        return this.anthropic.complete({
          ...effectiveReq,
          // Repassa apiKey como propriedade in-band (LlmService aceita).
          ...(resolved.source === 'ORG' ? { apiKey: resolved.apiKey } : {}),
        } as LlmCompletionRequest & { apiKey?: string });

      case AiProvider.OPENAI:
        return this.openai.complete(
          effectiveReq,
          resolved.apiKey!,
          resolved.baseUrl ?? undefined,
        );

      case AiProvider.GEMINI:
        return this.gemini.complete(effectiveReq, resolved.apiKey!);

      case AiProvider.KIMI:
        return this.kimi.complete(
          effectiveReq,
          resolved.apiKey!,
          resolved.baseUrl ?? undefined,
        );

      case AiProvider.ZAI:
        return this.zai.complete(
          effectiveReq,
          resolved.apiKey!,
          resolved.baseUrl ?? undefined,
        );

      default:
        throw new InternalServerErrorException(
          `Unsupported LLM provider: ${resolved.provider}`,
        );
    }
  }
}
