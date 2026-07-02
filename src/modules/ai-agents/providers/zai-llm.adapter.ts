import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';
import { defaultBaseUrlFor } from './provider-defaults';

/**
 * Adapter z.ai (Zhipu / GLM) — API OpenAI-compatible.
 *
 * Endpoint default internacional: `https://api.z.ai/api/paas/v4` (Bearer
 * direto — a API key vai como `Authorization: Bearer <key>`; o JWT assinado
 * do SDK `zhipuai` legado NÃO é necessário no endpoint v4). Org pode
 * sobrescrever via `OrganizationCredential.baseUrl` — ex: endpoint China
 * `https://open.bigmodel.cn/api/paas/v4`.
 *
 * Modelos válidos (jul/2026): `glm-4.6` (flagship barato), `glm-4.5-air`,
 * `glm-4.5-flash`/`glm-4.7-flash` (free), `glm-4.7`, `glm-5`, `glm-5.2`.
 * A geração 2024 `glm-4`/`glm-4-plus`/`glm-4-flash` saiu do catálogo z.ai
 * (pode resolver por retrocompat no bigmodel.cn, mas não garantido).
 *
 * Delega transporte/parsing pro `OpenAiCompatibleAdapter`.
 */
@Injectable()
export class ZaiLlmAdapter {
  private readonly logger = new Logger(ZaiLlmAdapter.name);
  readonly provider = AiProvider.ZAI;

  static readonly DEFAULT_MODEL = 'glm-4.6';

  /** Custo por token (USD) — pricing z.ai internacional, docs.z.ai (jul/2026). */
  private static readonly COST_TABLE: Record<string, { in: number; out: number }> = {
    'glm-4.6': { in: 0.6 / 1e6, out: 2.2 / 1e6 },
    'glm-4.5': { in: 0.6 / 1e6, out: 2.2 / 1e6 },
    'glm-4.7': { in: 0.6 / 1e6, out: 2.2 / 1e6 },
    'glm-4.5-air': { in: 0.2 / 1e6, out: 1.1 / 1e6 },
    'glm-4.7-flashx': { in: 0.07 / 1e6, out: 0.4 / 1e6 },
    'glm-4.7-flash': { in: 0, out: 0 },
    'glm-4.5-flash': { in: 0, out: 0 },
    'glm-5': { in: 1.0 / 1e6, out: 3.2 / 1e6 },
    'glm-5.2': { in: 1.4 / 1e6, out: 4.4 / 1e6 },
  };

  constructor(private readonly compat: OpenAiCompatibleAdapter) {}

  complete(
    req: LlmCompletionRequest,
    apiKey: string,
    baseUrl?: string,
  ): Promise<LlmCompletionResponse> {
    return this.compat.complete(req, apiKey, {
      baseUrl: baseUrl ?? defaultBaseUrlFor(this.provider)!,
      providerLabel: 'z.ai',
      defaultModel: ZaiLlmAdapter.DEFAULT_MODEL,
      normalizeModelId: (id) => this.normalizeModelId(id),
      costTable: ZaiLlmAdapter.COST_TABLE,
    });
  }

  private normalizeModelId(id: string): string {
    if (id.startsWith('zai/')) return id.slice('zai/'.length);
    if (id.startsWith('zhipu/')) return id.slice('zhipu/'.length);
    if (
      id.startsWith('claude-') ||
      id.startsWith('gpt-') ||
      id.startsWith('gemini') ||
      id.startsWith('kimi') ||
      id.startsWith('moonshot')
    ) {
      this.logger.warn(
        `Got non-GLM model "${id}" but routing is z.ai; defaulting to ${ZaiLlmAdapter.DEFAULT_MODEL}`,
      );
      return ZaiLlmAdapter.DEFAULT_MODEL;
    }
    return id;
  }
}
