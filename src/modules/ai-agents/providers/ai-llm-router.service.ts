import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';
import { OpenAiLlmAdapter } from './openai-llm.adapter';
import { GeminiLlmAdapter } from './gemini-llm.adapter';
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
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (!req.organizationId) {
      // Compat path — caller não setou orgId. Usa Anthropic env-based.
      return this.anthropic.complete(req);
    }

    const resolved = await this.resolver.resolveForLlm(req.organizationId);

    if (resolved.source === 'NONE') {
      throw new InternalServerErrorException(
        `No LLM credential available for org=${req.organizationId} (neither org-level nor env). Configure ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY env, or set org credential at /settings/ai-credentials`,
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
        return this.openai.complete(effectiveReq, resolved.apiKey!);

      case AiProvider.GEMINI:
        return this.gemini.complete(effectiveReq, resolved.apiKey!);

      default:
        throw new InternalServerErrorException(
          `Unsupported LLM provider: ${resolved.provider}`,
        );
    }
  }
}
