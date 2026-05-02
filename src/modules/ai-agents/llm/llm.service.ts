import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMessage,
  LlmToolDefinition,
  LlmUsage,
} from './llm.types';

/**
 * Talks to any LLM via OpenRouter's OpenAI-compatible API. Adds Anthropic
 * prompt-caching markers when the target model is `anthropic/*`.
 *
 * One service for every provider — the codebase only depends on this.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client: OpenAI;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('OPENROUTER_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'OPENROUTER_API_KEY not set — AI agents will fail at runtime',
      );
    }
    this.client = new OpenAI({
      apiKey: apiKey ?? 'missing',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        // OpenRouter uses these for analytics + leaderboard attribution.
        'HTTP-Referer': config.get<string>('APP_URL') ?? 'https://chat-bullq.dev',
        'X-Title': 'Chat BullQ',
      },
    });
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const isAnthropic = req.modelId.startsWith('anthropic/');
    const messages = this.toOpenAiMessages(req.messages, isAnthropic);
    const tools = req.tools ? this.toOpenAiTools(req.tools, isAnthropic) : undefined;

    let response: any;
    try {
      response = await this.client.chat.completions.create({
        model: req.modelId,
        messages,
        tools,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens ?? 2048,
        stream: false,
        ...(req.modelParams ?? {}),
        // OpenRouter returns cost when this is set.
        usage: { include: true },
      } as any);
    } catch (err: any) {
      this.logger.error(
        `LLM call failed [${req.modelId}]: ${err?.message ?? err}`,
      );
      throw new InternalServerErrorException(
        `LLM provider error: ${err?.message ?? 'unknown'}`,
      );
    }

    const choice = response.choices?.[0];
    if (!choice) {
      throw new InternalServerErrorException('LLM returned no choices');
    }

    const message = this.fromOpenAiMessage(choice.message);
    const stopReason = this.normalizeStopReason(choice.finish_reason);
    const usage = this.extractUsage(response);

    return {
      message,
      stopReason,
      usage,
      rawModelId: response.model ?? req.modelId,
    };
  }

  // ─── conversion: our types → OpenAI SDK ──────────────────────────

  private toOpenAiMessages(
    messages: LlmMessage[],
    enableCache: boolean,
  ): ChatCompletionMessageParam[] {
    return messages.map((m): ChatCompletionMessageParam => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.toolCallId!,
          content:
            typeof m.content === 'string'
              ? m.content
              : m.content.map((p) => p.text).join(''),
        };
      }
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content:
            typeof m.content === 'string'
              ? m.content
              : m.content.map((p) => p.text).join(''),
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                })),
              }
            : {}),
        };
      }

      // role: 'system' | 'user' — the only ones where caching applies
      const blocks =
        typeof m.content === 'string'
          ? [{ type: 'text' as const, text: m.content, cache: false }]
          : m.content;

      const content = blocks.map((b) => {
        const part: Record<string, unknown> = { type: 'text', text: b.text };
        if (enableCache && b.cache) {
          // OpenRouter passes cache_control to Anthropic models.
          part.cache_control = { type: 'ephemeral' };
        }
        return part;
      });

      return {
        role: m.role as 'system' | 'user',
        content: content as unknown as ChatCompletionMessageParam['content'],
      } as ChatCompletionMessageParam;
    });
  }

  private toOpenAiTools(
    tools: LlmToolDefinition[],
    enableCache: boolean,
  ): ChatCompletionTool[] {
    const result: ChatCompletionTool[] = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    // Mark the tools array as cacheable for Anthropic — the schemas are
    // stable so this saves ~95% of the tool-token cost on every call.
    if (enableCache && result.length > 0) {
      // Hack: we attach cache_control to the last tool. OpenRouter forwards
      // it to Anthropic, which interprets it as "cache everything up to here".
      (result[result.length - 1] as unknown as { cache_control: unknown }).cache_control = {
        type: 'ephemeral',
      };
    }

    return result;
  }

  // ─── conversion: OpenAI SDK → our types ──────────────────────────

  private fromOpenAiMessage(msg: any): LlmMessage {
    const toolCalls = msg.tool_calls?.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: this.safeParseJson(tc.function?.arguments),
    }));

    return {
      role: 'assistant',
      content: msg.content ?? '',
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private normalizeStopReason(
    reason?: string | null,
  ): LlmCompletionResponse['stopReason'] {
    switch (reason) {
      case 'stop':
      case 'end_turn':
        return 'stop';
      case 'tool_calls':
      case 'tool_use':
        return 'tool_calls';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'other';
    }
  }

  private extractUsage(response: any): LlmUsage {
    const u = response.usage ?? {};
    const promptTokensDetails = u.prompt_tokens_details ?? {};
    return {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: promptTokensDetails.cached_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      // OpenRouter only returns `cost` when usage.include=true is set.
      costUsd: typeof u.cost === 'number' ? u.cost : 0,
    };
  }

  private safeParseJson(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== 'string') return {};
    try {
      return JSON.parse(raw);
    } catch {
      this.logger.warn(`Tool call had unparseable arguments: ${raw}`);
      return {};
    }
  }
}
