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
 * Adapter pra OpenAI Chat Completions API.
 *
 * Suporte W2 atual:
 *   - Text-only messages (system/user/assistant)
 *   - Tool calling (Function calling formato OpenAI)
 *   - Tool results de volta como `role:'tool'` messages
 *
 * NÃO suportado nesta iteração (tech debt — abrir issue se virar bloqueio):
 *   - Prompt caching ephemeral (OpenAI tem `prompt_caching_beta` diferente)
 *   - Multimodal (image input) — frontend não permite criar agente OpenAI
 *     com input de imagem hoje. Quando habilitar, mapear LlmImagePart pro
 *     formato `{type:'image_url', image_url:{url}}`.
 *
 * Cost calc: tabela hard-coded por modelo (igual Anthropic adapter).
 */
@Injectable()
export class OpenAiLlmAdapter {
  private readonly logger = new Logger(OpenAiLlmAdapter.name);
  readonly provider = AiProvider.OPENAI;

  private static readonly API_URL = 'https://api.openai.com/v1/chat/completions';

  async complete(req: LlmCompletionRequest, apiKey: string): Promise<LlmCompletionResponse> {
    const modelId = this.normalizeModelId(req.modelId);
    const messages = this.toOpenAiMessages(req.messages);
    const tools = req.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const body = {
      model: modelId,
      messages,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.7,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(req.modelParams ?? {}),
    };

    let res: Response;
    try {
      res = await fetch(OpenAiLlmAdapter.API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new InternalServerErrorException(
        `OpenAI request failed: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.logger.error(`OpenAI ${res.status}: ${errText.slice(0, 300)}`);
      throw new InternalServerErrorException(
        `OpenAI API returned ${res.status}: ${this.shortError(errText)}`,
      );
    }

    const data = (await res.json()) as OpenAiChatResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new InternalServerErrorException('OpenAI returned no choices');
    }

    const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: this.safeJsonParse(tc.function.arguments),
    }));

    const message: LlmMessage = {
      role: 'assistant',
      content: choice.message.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    const stopReason =
      choice.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'length'
          : 'stop';

    const usage = data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: this.estimateCost(modelId, data.usage),
        }
      : zeroUsage();

    return {
      message,
      stopReason: stopReason as LlmCompletionResponse['stopReason'],
      usage,
      rawModelId: data.model ?? modelId,
    };
  }

  private normalizeModelId(id: string): string {
    if (id.startsWith('openai/')) return id.slice('openai/'.length);
    // Default sensato quando alguém manda model id Anthropic mas roteamento
    // foi pra OpenAI — usa gpt-4o-mini como fallback razoável.
    if (id.startsWith('claude-')) {
      this.logger.warn(`Got claude-* model "${id}" but routing is OpenAI; defaulting to gpt-4o-mini`);
      return 'gpt-4o-mini';
    }
    return id;
  }

  private toOpenAiMessages(input: LlmMessage[]): OpenAiMessage[] {
    const out: OpenAiMessage[] = [];
    for (const m of input) {
      if (m.role === 'system') {
        out.push({ role: 'system', content: extractText(m) });
      } else if (m.role === 'user') {
        out.push({ role: 'user', content: extractText(m) });
      } else if (m.role === 'assistant') {
        const msg: OpenAiMessage = {
          role: 'assistant',
          content: extractText(m) || null,
        };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        out.push(msg);
      } else if (m.role === 'tool') {
        out.push({
          role: 'tool',
          content: extractText(m),
          tool_call_id: m.toolCallId!,
        });
      }
    }
    return out;
  }

  private safeJsonParse(s: string): Record<string, unknown> {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      this.logger.warn(`Failed to parse tool args: ${s.slice(0, 100)}`);
      return {};
    }
  }

  private shortError(body: string): string {
    try {
      const j = JSON.parse(body) as { error?: { message?: string } };
      return j.error?.message?.slice(0, 200) ?? body.slice(0, 200);
    } catch {
      return body.slice(0, 200);
    }
  }

  /**
   * Approximate cost por modelo. Tabela conservadora (preços oficiais
   * OpenAI Aug 2024). Atualizar conforme tabela mudar.
   */
  private estimateCost(model: string, usage: { prompt_tokens: number; completion_tokens: number }): number {
    const rates: Record<string, { in: number; out: number }> = {
      'gpt-4o': { in: 2.5 / 1e6, out: 10 / 1e6 },
      'gpt-4o-mini': { in: 0.15 / 1e6, out: 0.6 / 1e6 },
      'gpt-4-turbo': { in: 10 / 1e6, out: 30 / 1e6 },
      'gpt-3.5-turbo': { in: 0.5 / 1e6, out: 1.5 / 1e6 },
    };
    const rate = rates[model] ?? rates['gpt-4o-mini'];
    return usage.prompt_tokens * rate.in + usage.completion_tokens * rate.out;
  }
}

// ─── Types internos (não-exportados) ───────────────────────────────

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
