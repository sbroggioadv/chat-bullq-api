import { Injectable, Logger } from '@nestjs/common';
import {
  MessageDirection,
  MessageStatus,
  type Message,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AiLlmRouterService } from '../ai-agents/providers/ai-llm-router.service';
import type { LlmMessage } from '../ai-agents/llm/llm.types';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { JARVIS_SYSTEM_PROMPT } from './jarvis-desk.prompt';
import { JARVIS_TOOL_DEFINITIONS, JarvisDeskTools } from './jarvis-desk.tools';

const MAX_ITERS = 6;
const MAX_HISTORY = 24;

@Injectable()
export class JarvisDeskRunner {
  private readonly logger = new Logger(JarvisDeskRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: AiLlmRouterService,
    private readonly tools: JarvisDeskTools,
    private readonly realtime: RealtimeGateway,
  ) {}

  async handleOperatorMessage(params: {
    organizationId: string;
    conversationId: string;
    trigger: Message;
  }): Promise<void> {
    const { organizationId, conversationId, trigger } = params;
    try {
      const history = await this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: MAX_HISTORY,
        select: { direction: true, content: true, sender: { select: { name: true } } },
      });

      const messages: LlmMessage[] = [
        { role: 'system', content: JARVIS_SYSTEM_PROMPT },
        ...history
          .slice()
          .reverse()
          .map((m): LlmMessage => {
            const text = preview(m.content);
            if (m.direction === MessageDirection.OUTBOUND) {
              const who = m.sender?.name ? `${m.sender.name}: ` : '';
              return { role: 'user', content: `${who}${text}` };
            }
            return { role: 'assistant', content: text };
          }),
      ];

      let reply = '';
      for (let i = 0; i < MAX_ITERS; i += 1) {
        const result = await this.llm.complete({
          organizationId,
          modelId: 'fugu-ultra',
          messages,
          tools: JARVIS_TOOL_DEFINITIONS,
          maxTokens: 1200,
        });

        if (result.stopReason === 'tool_calls' && result.message.toolCalls?.length) {
          messages.push(result.message);
          for (const call of result.message.toolCalls) {
            const output = await this.tools.execute(
              organizationId,
              call.name,
              call.arguments ?? {},
            );
            messages.push({
              role: 'tool',
              name: call.name,
              toolCallId: call.id,
              content: JSON.stringify(output),
            });
          }
          continue;
        }

        reply = typeof result.message.content === 'string' ? result.message.content : '';
        break;
      }

      if (!reply.trim()) {
        reply =
          'Não consegui montar a resposta agora. Tenta de novo em instantes, ou pergunta de outro jeito — por exemplo: "quantas presas?" ou "quem está sem resposta há 30 minutos?".';
      }

      await this.persistInbound(conversationId, reply, trigger.id);
    } catch (err) {
      this.logger.error(
        `Jarvis desk failed conv=${conversationId}: ${(err as Error).message}`,
      );
      const fallback =
        'Não consegui consultar o inbox agora (chave de IA ou erro interno). ' +
        'Confere Configurações → Credenciais de IA (Fugu Ultra / Qwen 3.7 Max) e tenta de novo.';
      await this.persistInbound(conversationId, fallback, trigger.id).catch(() => undefined);
    }
  }

  private async persistInbound(
    conversationId: string,
    text: string,
    inReplyToId: string,
  ): Promise<void> {
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.INBOUND,
        type: 'TEXT',
        status: MessageStatus.DELIVERED,
        content: { text },
        metadata: { jarvis: true, inReplyToId },
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });
    this.realtime.emitToConversation(conversationId, 'message:new', { message });
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channelId: true, contactId: true },
    });
    if (conv) {
      this.realtime.emitToChannel(conv.channelId, 'message:new', {
        message,
        conversationId,
        contactId: conv.contactId,
      });
    }
  }
}

function preview(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  return typeof c.text === 'string' ? c.text : '';
}
