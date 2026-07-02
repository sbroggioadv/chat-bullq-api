import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';
import { defaultBaseUrlFor } from './provider-defaults';

/**
 * Adapter pra OpenAI Chat Completions API.
 *
 * Casca fina sobre `OpenAiCompatibleAdapter` — só carrega os defaults da
 * OpenAI (base URL, modelo fallback, tabela de custo, normalização de model
 * id). A lógica de transporte/mapeamento/tool-calling vive no adapter
 * compartilhado, reusado também por Kimi e z.ai.
 *
 * Suporte atual: text-only messages + tool calling. NÃO suportado: prompt
 * caching ephemeral, multimodal (image input), streaming.
 */
@Injectable()
export class OpenAiLlmAdapter {
  private readonly logger = new Logger(OpenAiLlmAdapter.name);
  readonly provider = AiProvider.OPENAI;

  static readonly DEFAULT_MODEL = 'gpt-4o-mini';

  /**
   * Custo aproximado por token (USD). Tabela conservadora (preços oficiais
   * OpenAI Aug 2024). Atualizar conforme tabela mudar.
   */
  private static readonly COST_TABLE: Record<string, { in: number; out: number }> = {
    'gpt-4o': { in: 2.5 / 1e6, out: 10 / 1e6 },
    'gpt-4o-mini': { in: 0.15 / 1e6, out: 0.6 / 1e6 },
    'gpt-4-turbo': { in: 10 / 1e6, out: 30 / 1e6 },
    'gpt-3.5-turbo': { in: 0.5 / 1e6, out: 1.5 / 1e6 },
  };

  constructor(private readonly compat: OpenAiCompatibleAdapter) {}

  complete(
    req: LlmCompletionRequest,
    apiKey: string,
    baseUrl?: string,
  ): Promise<LlmCompletionResponse> {
    return this.compat.complete(req, apiKey, {
      baseUrl: baseUrl ?? defaultBaseUrlFor(this.provider)!,
      providerLabel: 'OpenAI',
      defaultModel: OpenAiLlmAdapter.DEFAULT_MODEL,
      normalizeModelId: (id) => this.normalizeModelId(id),
      costTable: OpenAiLlmAdapter.COST_TABLE,
    });
  }

  private normalizeModelId(id: string): string {
    if (id.startsWith('openai/')) return id.slice('openai/'.length);
    // Default sensato quando alguém manda model id Anthropic mas roteamento
    // foi pra OpenAI — usa gpt-4o-mini como fallback razoável.
    if (id.startsWith('claude-')) {
      this.logger.warn(
        `Got claude-* model "${id}" but routing is OpenAI; defaulting to ${OpenAiLlmAdapter.DEFAULT_MODEL}`,
      );
      return OpenAiLlmAdapter.DEFAULT_MODEL;
    }
    return id;
  }
}
