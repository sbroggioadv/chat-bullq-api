import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../llm/llm.types';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';
import { defaultBaseUrlFor } from './provider-defaults';

/**
 * Adapter Alibaba Qwen (DashScope compatible-mode).
 * Default internacional: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.
 * Atendimento: Qwen 3.7 Max (`qwen3.7-max`).
 */
@Injectable()
export class QwenLlmAdapter {
  private readonly logger = new Logger(QwenLlmAdapter.name);
  readonly provider = AiProvider.QWEN;

  static readonly DEFAULT_MODEL = 'qwen3.7-max';

  private static readonly COST_TABLE: Record<string, { in: number; out: number }> = {
    'qwen3.7-max': { in: 2.5 / 1e6, out: 7.5 / 1e6 },
    'qwen-3.7-max': { in: 2.5 / 1e6, out: 7.5 / 1e6 },
    'qwen3-max': { in: 2.5 / 1e6, out: 7.5 / 1e6 },
  };

  constructor(private readonly compat: OpenAiCompatibleAdapter) {}

  complete(
    req: LlmCompletionRequest,
    apiKey: string,
    baseUrl?: string,
  ): Promise<LlmCompletionResponse> {
    return this.compat.complete(req, apiKey, {
      baseUrl: baseUrl ?? defaultBaseUrlFor(this.provider)!,
      providerLabel: 'Qwen',
      defaultModel: QwenLlmAdapter.DEFAULT_MODEL,
      normalizeModelId: (id) => this.normalizeModelId(id),
      costTable: QwenLlmAdapter.COST_TABLE,
    });
  }

  normalizeModelId(id: string): string {
    let raw = id;
    if (raw.startsWith('qwen/')) raw = raw.slice('qwen/'.length);
    if (raw.startsWith('alibaba/')) raw = raw.slice('alibaba/'.length);
    if (raw.startsWith('dashscope/')) raw = raw.slice('dashscope/'.length);
    const aliases: Record<string, string> = {
      'qwen-3.7-max': QwenLlmAdapter.DEFAULT_MODEL,
      'qwen3-max': QwenLlmAdapter.DEFAULT_MODEL,
      'qwen3.7-max': QwenLlmAdapter.DEFAULT_MODEL,
    };
    if (aliases[raw]) return aliases[raw];
    if (raw.startsWith('qwen')) return raw;
    this.logger.warn(
      `Got non-Qwen model "${id}" but routing is Qwen; defaulting to ${QwenLlmAdapter.DEFAULT_MODEL}`,
    );
    return QwenLlmAdapter.DEFAULT_MODEL;
  }
}
