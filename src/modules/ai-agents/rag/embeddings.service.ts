import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  ProviderResolverService,
  type ResolvedCredential,
} from '../providers/provider-resolver.service';
import { defaultBaseUrlFor } from '../providers/provider-defaults';
import type { EmbeddingResult } from './types';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const COST_PER_1M_TOKENS = 0.02;

/**
 * Embeddings via API OpenAI-compatible (`POST {baseUrl}/embeddings`).
 * Sakana Fugu e OpenAI nativo usam o mesmo contrato — muda só host + chave.
 * Dimensão canônica: 1536 (`text-embedding-3-small`).
 */
@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly resolver: ProviderResolverService,
  ) {}

  async embed(text: string, organizationId?: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text], organizationId);
    return results[0];
  }

  async embedBatch(
    texts: string[],
    organizationId?: string,
  ): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const target = await this.resolveTarget(organizationId);
    const t0 = Date.now();
    const url = `${target.baseUrl.replace(/\/$/, '')}/embeddings`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: target.model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Embeddings API ${response.status} ${url} model=${target.model}: ${body.slice(0, 300)}`,
      );
      throw new InternalServerErrorException(
        `Embeddings API error (${response.status}): ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
      usage: { total_tokens: number };
    };

    const totalTokens = data.usage?.total_tokens ?? 0;
    const totalCost = (totalTokens / 1_000_000) * COST_PER_1M_TOKENS;
    const perCallTokens = Math.round(totalTokens / texts.length);
    const perCallCost = totalCost / texts.length;

    this.logger.log(
      `embedding_batch count=${texts.length} provider=${target.provider} model=${target.model} tokens=${totalTokens} durationMs=${Date.now() - t0}`,
    );

    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    return sorted.map((item) => ({
      vector: item.embedding,
      model: target.model,
      tokensUsed: perCallTokens,
      costUsd: perCallCost,
    }));
  }

  private async resolveTarget(organizationId?: string): Promise<{
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
  }> {
    if (organizationId) {
      const resolved = await this.resolver.resolveForEmbeddings(organizationId);
      if (resolved.source !== 'NONE' && resolved.apiKey) {
        return this.fromResolved(resolved);
      }
    }

    const fuguKey =
      this.config.get<string>('FUGU_API_KEY') ??
      process.env.FUGU_API_KEY ??
      this.config.get<string>('SAKANA_API_KEY') ??
      process.env.SAKANA_API_KEY ??
      '';
    if (fuguKey) {
      return {
        provider: AiProvider.FUGU,
        apiKey: fuguKey,
        baseUrl: defaultBaseUrlFor(AiProvider.FUGU)!,
        model: DEFAULT_EMBEDDING_MODEL,
      };
    }

    const openaiKey =
      this.config.get<string>('OPENAI_API_KEY') ??
      process.env.OPENAI_API_KEY ??
      '';
    if (openaiKey) {
      return {
        provider: AiProvider.OPENAI,
        apiKey: openaiKey,
        baseUrl: defaultBaseUrlFor(AiProvider.OPENAI)!,
        model: DEFAULT_EMBEDDING_MODEL,
      };
    }

    throw new InternalServerErrorException(
      'Embeddings não configurados. Use Sakana Fugu (OpenAI-compat) ou OpenAI em Credenciais de IA.',
    );
  }

  private fromResolved(resolved: ResolvedCredential): {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
  } {
    const baseUrl =
      resolved.baseUrl ||
      defaultBaseUrlFor(resolved.provider) ||
      defaultBaseUrlFor(AiProvider.OPENAI)!;
    return {
      provider: resolved.provider,
      apiKey: resolved.apiKey!,
      baseUrl,
      model: resolved.modelOverride?.trim() || DEFAULT_EMBEDDING_MODEL,
    };
  }
}
