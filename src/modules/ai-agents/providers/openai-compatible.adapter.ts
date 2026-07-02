import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMessage,
  LlmToolCall,
} from '../llm/llm.types';
import { extractText, zeroUsage } from './llm-adapter';

/**
 * Config de runtime pra uma chamada OpenAI-compatible. Cada provider concreto
 * (OpenAI, Kimi/Moonshot, z.ai/Zhipu) fornece seus próprios defaults e delega
 * a lógica de transporte/parsing pra este adapter compartilhado.
 */
export interface OpenAiCompatibleConfig {
  /**
   * Base URL SEM trailing slash e SEM o path `/chat/completions`.
   * Ex: `https://api.openai.com/v1`, `https://api.moonshot.ai/v1`,
   * `https://api.z.ai/api/paas/v4`.
   */
  baseUrl: string;
  /** Rótulo humano pra logs/erros: 'OpenAI' | 'Kimi' | 'z.ai'. */
  providerLabel: string;
  /** Model usado quando `normalizeModelId` não consegue resolver o input. */
  defaultModel: string;
  /** Normaliza o `modelId` recebido pro id que o provider aceita. */
  normalizeModelId: (id: string) => string;
  /**
   * Tabela de custo por modelo em USD por token (in/out). Fallback pro
   * `defaultModel` quando o modelo retornado não estiver na tabela.
   */
  costTable: Record<string, { in: number; out: number }>;
}

/**
 * Adapter genérico pra qualquer API compatível com OpenAI Chat Completions
 * (`POST {baseUrl}/chat/completions`, auth `Authorization: Bearer <key>`).
 *
 * Extraído do antigo `OpenAiLlmAdapter` pra ser reusado por Kimi (Moonshot) e
 * z.ai (Zhipu/GLM) sem duplicar mapeamento de mensagens, tool calling e
 * parsing de usage. O `OpenAiLlmAdapter` agora é uma casca fina sobre este.
 *
 * Suporte atual:
 *   - Text-only messages (system/user/assistant/tool)
 *   - Tool calling (function calling formato OpenAI) + tool results
 *
 * NÃO envia `functions` (legado) nem injeta `tool_choice` — mantém compat com
 * Kimi (que rejeita `functions` e `tool_choice:"required"`). Overrides ficam
 * a cargo do caller via `req.modelParams`.
 *
 * NÃO suportado (tech debt herdado do OpenAI adapter):
 *   - Prompt caching / multimodal / streaming
 */
@Injectable()
export class OpenAiCompatibleAdapter {
  private readonly logger = new Logger(OpenAiCompatibleAdapter.name);

  async complete(
    req: LlmCompletionRequest,
    apiKey: string,
    cfg: OpenAiCompatibleConfig,
  ): Promise<LlmCompletionResponse> {
    const modelId = cfg.normalizeModelId(req.modelId);
    const messages = this.toMessages(req.messages);
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

    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new InternalServerErrorException(
        `${cfg.providerLabel} request failed: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.logger.error(`${cfg.providerLabel} ${res.status}: ${errText.slice(0, 300)}`);
      throw new InternalServerErrorException(
        `${cfg.providerLabel} API returned ${res.status}: ${this.shortError(errText)}`,
      );
    }

    const data = (await res.json()) as OpenAiChatResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new InternalServerErrorException(`${cfg.providerLabel} returned no choices`);
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
          costUsd: this.estimateCost(cfg, data.model ?? modelId, data.usage),
        }
      : zeroUsage();

    return {
      message,
      stopReason: stopReason as LlmCompletionResponse['stopReason'],
      usage,
      rawModelId: data.model ?? modelId,
    };
  }

  private toMessages(input: LlmMessage[]): OpenAiMessage[] {
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

  private estimateCost(
    cfg: OpenAiCompatibleConfig,
    model: string,
    usage: { prompt_tokens: number; completion_tokens: number },
  ): number {
    const rate = cfg.costTable[model] ?? cfg.costTable[cfg.defaultModel];
    if (!rate) return 0;
    return usage.prompt_tokens * rate.in + usage.completion_tokens * rate.out;
  }
}

// ─── Types internos (compartilhados pelos providers OpenAI-compatible) ──────

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
