import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../../../database/prisma.service';
import { GroupNotifyService } from '../client-ops/group-notify.service';
import { NotificationsService } from '../../../notifications/notifications.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { PendingActionService } from '../../confirmations/pending-action.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

const handoffSchema = z.object({
  notifyGroupJid: z.string().trim().regex(/^[^\s@]+@g\.us$/),
  assigneeUserId: z.string().trim().min(1),
  notifyLine: z.string().trim().min(1),
});
/**
 * Configured groups pause and assign immediately, notify the internal group and
 * the assignee. Individual/unconfigured conversations retain the approval path:
 * PendingAction + realtime notification, with mutation only after approval.
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
    private readonly realtime: RealtimeGateway,
    private readonly pendingActions: PendingActionService,
    private readonly prisma: PrismaService,
    private readonly groupNotify: GroupNotifyService,
    private readonly notifications: NotificationsService,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const reason = String(input.reason ?? '').trim() || 'Handoff sem motivo informado';
    const summary = input.summary ? String(input.summary).trim() : null;

    const immediate = await this.configuredGroupHandoff(reason, ctx);
    if (immediate) return immediate;

    const preview = {
      action: `Transferir conversa pro atendimento humano: ${reason}`,
      impact: 'critical' as const,
      rollback:
        'Reativar IA na conversa (aiEnabled=true) e devolver pra fila do bot.',
      affectedEntity: {
        type: 'conversation' as const,
        id: ctx.conversationId,
        label: `conversation:${ctx.conversationId}`,
      },
    };

    const action = await this.pendingActions.create({
      agentRunId: ctx.runId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      toolName: this.name,
      args: { reason, summary },
      preview,
    });

    // Notifica o operador imediatamente — ele revisa a fila de pendências
    // e aprova/rejeita. A pausa da IA acontece SOMENTE após aprovação,
    // pelo executor da fase 2.
    this.realtime.emitToConversation(
      ctx.conversationId,
      'conversation:pending-action',
      {
        conversationId: ctx.conversationId,
        pendingActionId: action.id,
        toolName: this.name,
        impact: preview.impact,
        reason,
      },
    );

    this.logger.log(
      `Agent ${ctx.agentId} requested handoff for conv ${ctx.conversationId} → pendingAction=${action.id} (reason="${reason}")`,
    );

    return {
      output: {
        ok: true,
        status: 'queued_for_processing',
        pendingActionId: action.id,
        preview,
        message:
          'Transferência registrada com sucesso. A equipe foi acionada e vai dar continuidade — fluxo padrão, não é erro.',
        agent_should_say:
          'Avise o cliente, com naturalidade, que a equipe foi acionada e vai dar continuidade. Não prometa horário nem prazo de retorno. NÃO mencione "aprovação", "operador", "PendingAction" ou qualquer detalhe interno.',
      },
      // Mantém o sinal de "saí do loop" — o agent deve parar de responder
      // até o operador decidir. Sem isso o LLM seguiria conversando como
      // se tivesse transferido de fato.
      finalAction: 'TRANSFERRED_TO_HUMAN',
    };
  }

  private async configuredGroupHandoff(reason: string, ctx: ToolContext): Promise<ToolResult | null> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: ctx.conversationId, organizationId: ctx.organizationId },
      include: { contact: { select: { name: true } } },
    });
    if (!conversation?.isGroup) return null;
    const organization = await this.prisma.organization.findUnique({
      where: { id: ctx.organizationId }, select: { settings: true },
    });
    const settings = organization?.settings as Record<string, unknown> | null;
    if (!settings || !Object.prototype.hasOwnProperty.call(settings, 'aiHandoff')) return null;
    const parsed = handoffSchema.safeParse(settings.aiHandoff);
    if (!parsed.success) {
      this.logger.error(`Run ${ctx.runId}: invalid aiHandoff configuration`);
      return null;
    }
    const config = parsed.data;
    const member = await this.prisma.userOrganization.findFirst({
      where: { userId: config.assigneeUserId, organizationId: ctx.organizationId }, select: { userId: true },
    });
    if (!member) {
      this.logger.error(`Run ${ctx.runId}: aiHandoff assignee outside organization`);
      return null;
    }
    const updated = await this.prisma.conversation.updateMany({
      where: { id: ctx.conversationId, organizationId: ctx.organizationId, OR: [{ aiEnabled: null }, { aiEnabled: true }] },
      data: { aiEnabled: false, assignedToId: config.assigneeUserId, activeAgentId: null },
    });
    if (!updated.count) {
      const current = await this.prisma.conversation.findFirst({
        where: { id: ctx.conversationId, organizationId: ctx.organizationId },
        select: { aiEnabled: true },
      });
      if (current?.aiEnabled === false) return this.immediateResult({ alreadyTransferred: true });
      this.logger.error(`Run ${ctx.runId}: aiHandoff pause not confirmed; state=${JSON.stringify(current)}`);
      return null;
    }
    const groupName = conversation.contact.name?.trim() || 'Grupo sem nome';
    let notified = false;
    let skipped = false;
    try {
      const result = await this.groupNotify.notifyGroupByJid({
        organizationId: ctx.organizationId, groupJid: config.notifyGroupJid,
        text: `Chamado da IA\nGrupo: ${groupName}\nMotivo: ${reason.slice(0, 300)}\n${config.notifyLine}`,
        currentConversationId: ctx.conversationId, senderName: 'Equipe',
      });
      notified = result.sent;
      skipped = result.reason === 'skipped_same_conversation';
      if (!notified && !skipped) this.logger.error(`Run ${ctx.runId}: aiHandoff group notification failed: ${result.reason ?? 'not sent'}`);
    } catch (err: any) {
      this.logger.error(`Run ${ctx.runId}: aiHandoff group notification failed: ${err?.message ?? err}`);
    }
    try {
      await this.notifications.notify({
        recipientId: config.assigneeUserId, organizationId: ctx.organizationId,
        type: !notified && !skipped ? NotificationType.AI_TOOL_FAILURE : NotificationType.CONVERSATION_ASSIGNED, title: 'Chamado da IA',
        body: `${!notified && !skipped ? 'O aviso no grupo interno falhou. ' : ''}Conversa pausada e atribuída a você. Grupo: ${groupName}. Motivo: ${reason.slice(0, 300)}`,
        data: { conversationId: ctx.conversationId, runId: ctx.runId, notified },
      });
    } catch (err: any) {
      this.logger.error(`Run ${ctx.runId}: aiHandoff assignee notification failed: ${err?.message ?? err}`);
    }
    return this.immediateResult({ notified, ...(skipped ? { reason: 'skipped_same_conversation' } : {}) });
  }

  private immediateResult(details: Record<string, unknown>): ToolResult {
    return {
      output: {
        ok: true, status: 'transferred', ...details,
        message: 'Transferência registrada com sucesso. A equipe foi acionada e vai dar continuidade — fluxo padrão, não é erro.',
        agent_should_say: 'Avise o cliente, com naturalidade, que a equipe foi acionada e vai dar continuidade. Não prometa horário nem prazo de retorno. NÃO mencione "aprovação", "operador", "PendingAction" ou qualquer detalhe interno.',
      },
      finalAction: 'TRANSFERRED_TO_HUMAN',
    };
  }
}
