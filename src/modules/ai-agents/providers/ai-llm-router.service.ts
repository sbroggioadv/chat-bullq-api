import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';
import { OpenAiLlmAdapter } from './openai-llm.adapter';
import { GeminiLlmAdapter } from './gemini-llm.adapter';
import { KimiLlmAdapter } from './kimi-llm.adapter';
import { ZaiLlmAdapter } from './zai-llm.adapter';
import { FuguLlmAdapter } from './fugu-llm.adapter';
import { QwenLlmAdapter } from './qwen-llm.adapter';
import {
  ProviderResolverService,
  type ResolvedCredential,
} from './provider-resolver.service';

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
    private readonly fugu: FuguLlmAdapter,
    private readonly qwen: QwenLlmAdapter,
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (!req.organizationId) {
      // Compat path — caller não setou orgId. Usa Anthropic env-based.
      return this.anthropic.complete(req);
    }

    const resolved = await this.resolver.resolveForLlm(req.organizationId);

    if (resolved.source === 'NONE') {
      throw new InternalServerErrorException(
        `No LLM credential available for org=${req.organizationId} (neither org-level nor env). Configure FUGU_API_KEY / SAKANA_API_KEY or QWEN_API_KEY / DASHSCOPE_API_KEY, or set org credential at /settings/ai-credentials`,
      );
    }

    return this.dispatch(resolved, req);
  }

  /**
   * Atendimento (Jarvis desk + canal de inbox): Fugu Ultra, Qwen 3.7 Max se
   * o Fugu falhar. Ignora OrganizationCapabilityRouting — um LLM_AGENT=ZAI
   * sem saldo não pode silenciar o Jarvis.
   */
  async completeAttendance(
    req: LlmCompletionRequest,
  ): Promise<LlmCompletionResponse> {
    if (!req.organizationId) {
      throw new InternalServerErrorException(
        'completeAttendance requires organizationId',
      );
    }

    const chain: Array<{ provider: AiProvider; modelId: string }> = [
      { provider: AiProvider.FUGU, modelId: FuguLlmAdapter.DEFAULT_MODEL },
      { provider: AiProvider.QWEN, modelId: QwenLlmAdapter.DEFAULT_MODEL },
    ];

    const errors: string[] = [];
    for (const step of chain) {
      const resolved = await this.resolver.resolveProvider(
        req.organizationId,
        step.provider,
      );
      if (resolved.source === 'NONE' || !resolved.apiKey) {
        errors.push(`${step.provider}: no credential`);
        continue;
      }
      try {
        return await this.dispatch(resolved, { ...req, modelId: step.modelId });
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.warn(
          `Attendance LLM ${step.provider} failed for org=${req.organizationId}: ${msg}`,
        );
        errors.push(`${step.provider}: ${msg}`);
      }
    }

    throw new InternalServerErrorException(
      `Attendance LLM unavailable (Fugu then Qwen): ${errors.join('; ')}`,
    );
  }

  private dispatch(
    resolved: ResolvedCredential,
    req: LlmCompletionRequest,
  ): Promise<LlmCompletionResponse> {
    const effectiveReq: LlmCompletionRequest = resolved.modelOverride
      ? { ...req, modelId: resolved.modelOverride }
      : req;

    switch (resolved.provider) {
      case AiProvider.ANTHROPIC:
        return this.anthropic.complete({
          ...effectiveReq,
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

      case AiProvider.FUGU:
        return this.fugu.complete(
          effectiveReq,
          resolved.apiKey!,
          resolved.baseUrl ?? undefined,
        );

      case AiProvider.QWEN:
        return this.qwen.complete(
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
