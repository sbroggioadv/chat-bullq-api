import { Injectable, Logger } from '@nestjs/common';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Hands the conversation off to a human. Pauses AI on this conversation
 * (so the agent stops responding), moves status to PENDING (so it shows
 * up in the queue), and clears the active agent.
 */
@Injectable()
export class TransferToHumanTool implements AiTool {
  private readonly logger = new Logger(TransferToHumanTool.name);

  readonly name = 'transferToHuman';
  readonly description =
    'Hand the conversation over to a human agent. Use this when: the request is outside your competence, the customer explicitly asks for a person, the situation is sensitive (complaint, refund, anger), or you are uncertain. The conversation will move to the queue and AI will be paused.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        description:
          'Short reason for the handoff, in PT-BR. Visible to the human as an internal note. e.g., "Cliente pediu reembolso, fora do meu escopo".',
        minLength: 3,
        maxLength: 500,
      },
      summary: {
        type: 'string',
        description:
          'Optional short summary of the conversation so far so the human picks up faster.',
        maxLength: 1000,
      },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const reason = String(input.reason ?? '').trim() || 'Handoff sem motivo informado';
    const summary = input.summary ? String(input.summary).trim() : null;

    await this.prisma.$transaction([
      this.prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: {
          aiEnabled: false,
          aiDisabledBy: `agent:${ctx.agentId}`,
          aiDisabledAt: new Date(),
          activeAgentId: null,
          status: ConversationStatus.PENDING,
          assignedToId: null,
        },
      }),
      this.prisma.conversationAuditLog.create({
        data: {
          conversationId: ctx.conversationId,
          actorId: null,
          action: 'AI_HANDOFF_TO_HUMAN',
          metadata: { agentId: ctx.agentId, reason, summary, runId: ctx.runId },
        },
      }),
    ]);

    this.realtime.emitToConversation(ctx.conversationId, 'conversation:ai-paused', {
      conversationId: ctx.conversationId,
      reason,
    });

    this.logger.log(
      `Agent ${ctx.agentId} handed conv ${ctx.conversationId} to human: ${reason}`,
    );

    return {
      output: { ok: true, message: 'Conversation handed off to human queue' },
      finalAction: 'TRANSFERRED_TO_HUMAN',
    };
  }
}
