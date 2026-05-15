import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMessage,
  LlmToolCall,
} from '../llm/llm.types';
import { extractText, zeroUsage } from './llm-adapter';

/**
 * Adapter pra Google Gemini generateContent API (REST direta, sem SDK).
 *
 * Decisão CTO: HTTP direto ao invés de `@google/generative-ai` SDK pra
 * evitar dep adicional (peso baixo, mas o adapter é simples o suficiente
 * pra não precisar). Migrar pro SDK se features avançadas (file uploads,
 * grounding, code execution) virarem requisito.
 *
 * Suporte W2 atual:
 *   - Text-only messages (mapeia 'system' pro campo `systemInstruction`)
 *   - Tool calling formato Gemini (`functionDeclarations` + `functionCall`)
 *
 * NÃO suportado nesta iteração:
 *   - Multimodal input (image)
 *   - Caching (Gemini context caching API)
 *   - Streaming
 *
 * Endpoint: POST /v1beta/models/{model}:generateContent?key={apiKey}
 */
@Injectable()
export class GeminiLlmAdapter {
  private readonly logger = new Logger(GeminiLlmAdapter.name);
  readonly provider = AiProvider.GEMINI;

  private static readonly API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

  async complete(req: LlmCompletionRequest, apiKey: string): Promise<LlmCompletionResponse> {
    const modelId = this.normalizeModelId(req.modelId);
    const { systemInstruction, contents } = this.toGeminiMessages(req.messages);
    const tools = req.tools
      ? [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ]
      : undefined;

    const body = {
      ...(systemInstruction ? { systemInstruction } : {}),
      contents,
      ...(tools ? { tools } : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0.7,
      },
    };

    const url = `${GeminiLlmAdapter.API_BASE}/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new InternalServerErrorException(
        `Gemini request failed: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.logger.error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
      throw new InternalServerErrorException(
        `Gemini API returned ${res.status}: ${this.shortError(errText)}`,
      );
    }

    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new InternalServerErrorException('Gemini returned no candidates');
    }

    const parts = candidate.content?.parts ?? [];
    const textParts = parts.filter((p) => 'text' in p) as Array<{ text: string }>;
    const functionCalls = parts.filter((p) => 'functionCall' in p) as Array<{
      functionCall: { name: string; args: Record<string, unknown> };
    }>;

    const toolCalls: LlmToolCall[] = functionCalls.map((fc, idx) => ({
      id: `gemini_fc_${Date.now()}_${idx}`,
      name: fc.functionCall.name,
      arguments: fc.functionCall.args ?? {},
    }));

    const message: LlmMessage = {
      role: 'assistant',
      content: textParts.map((p) => p.text).join('') || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    const stopReason = toolCalls.length > 0
      ? 'tool_calls'
      : candidate.finishReason === 'MAX_TOKENS'
        ? 'length'
        : candidate.finishReason === 'SAFETY'
          ? 'content_filter'
          : 'stop';

    const usage = data.usageMetadata
      ? {
          inputTokens: data.usageMetadata.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: this.estimateCost(modelId, data.usageMetadata),
        }
      : zeroUsage();

    return {
      message,
      stopReason: stopReason as LlmCompletionResponse['stopReason'],
      usage,
      rawModelId: modelId,
    };
  }

  private normalizeModelId(id: string): string {
    if (id.startsWith('gemini/')) return id.slice('gemini/'.length);
    if (id.startsWith('claude-') || id.startsWith('gpt-')) {
      this.logger.warn(`Got non-Gemini model "${id}" but routing is Gemini; defaulting to gemini-1.5-flash`);
      return 'gemini-1.5-flash';
    }
    return id;
  }

  private toGeminiMessages(input: LlmMessage[]): {
    systemInstruction?: { parts: Array<{ text: string }> };
    contents: GeminiContent[];
  } {
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    const contents: GeminiContent[] = [];

    for (const m of input) {
      if (m.role === 'system') {
        const text = extractText(m);
        if (text) systemInstruction = { parts: [{ text }] };
        continue;
      }
      if (m.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: extractText(m) }] });
      } else if (m.role === 'assistant') {
        const parts: GeminiPart[] = [];
        const text = extractText(m);
        if (text) parts.push({ text });
        for (const tc of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
        if (parts.length > 0) contents.push({ role: 'model', parts });
      } else if (m.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: m.name ?? 'unknown',
                response: { content: extractText(m) },
              },
            },
          ],
        });
      }
    }
    return { systemInstruction, contents };
  }

  private shortError(body: string): string {
    try {
      const j = JSON.parse(body) as { error?: { message?: string } };
      return j.error?.message?.slice(0, 200) ?? body.slice(0, 200);
    } catch {
      return body.slice(0, 200);
    }
  }

  /** Conservative pricing (Aug 2024). Update conforme Google publica. */
  private estimateCost(
    model: string,
    usage: { promptTokenCount?: number; candidatesTokenCount?: number },
  ): number {
    const rates: Record<string, { in: number; out: number }> = {
      'gemini-1.5-flash': { in: 0.075 / 1e6, out: 0.3 / 1e6 },
      'gemini-1.5-pro': { in: 1.25 / 1e6, out: 5 / 1e6 },
      'gemini-2.0-flash-exp': { in: 0.075 / 1e6, out: 0.3 / 1e6 },
    };
    const rate = rates[model] ?? rates['gemini-1.5-flash'];
    return (usage.promptTokenCount ?? 0) * rate.in + (usage.candidatesTokenCount ?? 0) * rate.out;
  }
}

// ─── Types internos ────────────────────────────────────────────────

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts: GeminiPart[] };
    finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
