import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';
import { defaultBaseUrlFor } from './provider-defaults';

/**
 * Adapter Sakana Fugu — API OpenAI-compatible (`https://api.sakana.ai/v1`).
 * Atendimento: Fugu Ultra (`fugu-ultra` / `fugu-ultra-v1.1`).
 */
@Injectable()
export class FuguLlmAdapter {
  private readonly logger = new Logger(FuguLlmAdapter.name);
  readonly provider = AiProvider.FUGU;

  static readonly DEFAULT_MODEL = 'fugu-ultra';

  private static readonly COST_TABLE: Record<string, { in: number; out: number }> = {
    'fugu-ultra': { in: 5 / 1e6, out: 30 / 1e6 },
    'fugu-ultra-v1.1': { in: 5 / 1e6, out: 30 / 1e6 },
    'fugu-ultra-v1.0': { in: 5 / 1e6, out: 30 / 1e6 },
    'fugu-ultra-20260615': { in: 5 / 1e6, out: 30 / 1e6 },
    fugu: { in: 0, out: 0 },
  };

  constructor(private readonly compat: OpenAiCompatibleAdapter) {}

  complete(
    req: LlmCompletionRequest,
    apiKey: string,
    baseUrl?: string,
  ): Promise<LlmCompletionResponse> {
    return this.compat.complete(req, apiKey, {
      baseUrl: baseUrl ?? defaultBaseUrlFor(this.provider)!,
      providerLabel: 'Sakana Fugu',
      defaultModel: FuguLlmAdapter.DEFAULT_MODEL,
      normalizeModelId: (id) => this.normalizeModelId(id),
      costTable: FuguLlmAdapter.COST_TABLE,
      omitTemperature: true,
    });
  }

  normalizeModelId(id: string): string {
    const raw = id.startsWith('sakana/') ? id.slice('sakana/'.length) : id;
    if (raw === 'fugu-ultra' || raw.startsWith('fugu-ultra-')) return raw;
    if (raw === 'fugu' || raw === 'fugu-cyber') return raw;
    this.logger.warn(
      `Got non-Fugu model "${id}" but routing is Fugu; defaulting to ${FuguLlmAdapter.DEFAULT_MODEL}`,
    );
    return FuguLlmAdapter.DEFAULT_MODEL;
  }
}
