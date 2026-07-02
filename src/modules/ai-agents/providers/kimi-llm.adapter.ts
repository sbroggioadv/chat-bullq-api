import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';
import { defaultBaseUrlFor } from './provider-defaults';

/**
 * Adapter Kimi (Moonshot AI) — API OpenAI-compatible.
 *
 * Endpoint default internacional: `https://api.moonshot.ai/v1` (Bearer direto).
 * Org pode sobrescrever via `OrganizationCredential.baseUrl` — ex: endpoint
 * China `https://api.moonshot.cn/v1`.
 *
 * Modelos válidos (jul/2026): família Kimi `kimi-k2.7-code`, `kimi-k2.6`,
 * `kimi-k2.5` e a família estável `moonshot-v1-8k/32k/128k`. Os snapshots
 * datados `kimi-k2-*-preview` foram EOL (25/05/2026) — não usar.
 *
 * Delega transporte/parsing pro `OpenAiCompatibleAdapter`.
 */
@Injectable()
export class KimiLlmAdapter {
  private readonly logger = new Logger(KimiLlmAdapter.name);
  readonly provider = AiProvider.KIMI;

  static readonly DEFAULT_MODEL = 'kimi-k2.6';

  /**
   * Custo aproximado por token (USD). Estimativas — as docs oficiais divergem
   * entre fontes p/ K2.6 ($0.60/$2.50 vs $0.95/$4.00); valores conservadores,
   * revisar quando o card oficial estabilizar. Preço da família moonshot-v1
   * não estava exposto na doc no momento — estimado.
   */
  private static readonly COST_TABLE: Record<string, { in: number; out: number }> = {
    'kimi-k2.6': { in: 0.6 / 1e6, out: 2.5 / 1e6 },
    'kimi-k2.5': { in: 0.6 / 1e6, out: 3.0 / 1e6 },
    'kimi-k2.7-code': { in: 0.6 / 1e6, out: 2.5 / 1e6 },
    'moonshot-v1-8k': { in: 0.2 / 1e6, out: 2.0 / 1e6 },
    'moonshot-v1-32k': { in: 0.5 / 1e6, out: 2.0 / 1e6 },
    'moonshot-v1-128k': { in: 0.8 / 1e6, out: 2.0 / 1e6 },
  };

  constructor(private readonly compat: OpenAiCompatibleAdapter) {}

  complete(
    req: LlmCompletionRequest,
    apiKey: string,
    baseUrl?: string,
  ): Promise<LlmCompletionResponse> {
    return this.compat.complete(req, apiKey, {
      baseUrl: baseUrl ?? defaultBaseUrlFor(this.provider)!,
      providerLabel: 'Kimi',
      defaultModel: KimiLlmAdapter.DEFAULT_MODEL,
      normalizeModelId: (id) => this.normalizeModelId(id),
      costTable: KimiLlmAdapter.COST_TABLE,
    });
  }

  private normalizeModelId(id: string): string {
    if (id.startsWith('kimi/')) return id.slice('kimi/'.length);
    if (id.startsWith('moonshot/')) return id.slice('moonshot/'.length);
    if (
      id.startsWith('claude-') ||
      id.startsWith('gpt-') ||
      id.startsWith('gemini')
    ) {
      this.logger.warn(
        `Got non-Kimi model "${id}" but routing is Kimi; defaulting to ${KimiLlmAdapter.DEFAULT_MODEL}`,
      );
      return KimiLlmAdapter.DEFAULT_MODEL;
    }
    return id;
  }
}
