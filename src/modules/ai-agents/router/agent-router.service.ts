import { Injectable, Logger } from '@nestjs/common';
import { Conversation, Organization } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { IntentClassifierService } from '../classifier/intent-classifier.service';
import { IntentRouterService } from '../classifier/intent-router.service';
import type {
  ClassificationResult,
  ClassifierMessage,
} from '../classifier/intent.types';
import { IntentType } from '../classifier/intent.types';
import { GroupMentionDetector } from '../scope/group-mention-detector.service';

interface BusinessHoursDay {
  enabled: boolean;
  windows?: Array<[string, string]>; // [["09:00","18:00"]]
}
type BusinessHoursConfig = Record<string, BusinessHoursDay>;

const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export interface AgentSelection {
  agentId: string;
  agentName: string;
  classifiedIntent: string | null;
  classifierConfidence: number | null;
  skippedOrchestrator: boolean;
  classifierCostUsd: number;
}

@Injectable()
export class AgentRouterService {
  private readonly logger = new Logger(AgentRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly classifier: IntentClassifierService,
    private readonly intentRouter: IntentRouterService,
    private readonly groupMentionDetector: GroupMentionDetector,
  ) {}

  /**
   * Resolve qual agente vai atender essa mensagem.
   *
   * Regras:
   * 1. Se a conversa já tem `activeAgentId` (continuação de conversa em andamento) →
   *    usa ele direto, sem classificar (evita re-roteamento no meio do papo).
   * 2. Se for primeira mensagem (sem activeAgentId) → chama IntentClassifier
   *    (Haiku ~200ms, ~$0.0003). Se confidence >= threshold e o intent for
   *    direcionável, pula o orchestrator e vai direto pro worker.
   * 3. Fallback: cai no orchestrator AUTONOMOUS do canal (Augusto).
   */
  async selectAgent(
    conversation: Conversation,
    latestMessageText: string,
    recentMessages: ClassifierMessage[] = [],
  ): Promise<AgentSelection | null> {
    // 1. Conversa em andamento — mantém o agent atual
    if (conversation.activeAgentId) {
      const agent = await this.prisma.aiAgent.findUnique({
        where: { id: conversation.activeAgentId },
        select: { id: true, name: true },
      });
      if (agent) {
        return {
          agentId: agent.id,
          agentName: agent.name,
          classifiedIntent: null,
          classifierConfidence: null,
          skippedOrchestrator: false,
          classifierCostUsd: 0,
        };
      }
    }

    // 2. Carrega threshold da org
    const org = await this.prisma.organization.findUnique({
      where: { id: conversation.organizationId },
      select: { aiClassifierThreshold: true },
    });
    const threshold = org?.aiClassifierThreshold
      ? Number(org.aiClassifierThreshold)
      : 0.85;

    // 3. Classifica
    let classification: ClassificationResult;
    try {
      classification = await this.classifier.classify(
        latestMessageText,
        recentMessages,
        { threshold },
      );
    } catch (err) {
      this.logger.warn({
        msg: 'classifier_failed_fallback_orchestrator',
        error: (err as Error).message,
      });
      return this.fallbackToOrchestrator(conversation);
    }

    // 4. Se confidence alta e intent direcionável → vai direto pro worker
    if (
      classification.skippedOrchestrator &&
      classification.suggestedAgent &&
      classification.intent !== IntentType.AMBIGUOUS &&
      classification.intent !== IntentType.SMALL_TALK
    ) {
      const agent = await this.prisma.aiAgent.findFirst({
        where: {
          organizationId: conversation.organizationId,
          name: classification.suggestedAgent,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true, name: true },
      });
      if (agent) {
        this.logger.log({
          msg: 'agent_selected_via_classifier',
          intent: classification.intent,
          confidence: classification.confidence,
          agentName: agent.name,
          costUsd: classification.costUsd,
        });
        return {
          agentId: agent.id,
          agentName: agent.name,
          classifiedIntent: classification.intent,
          classifierConfidence: classification.confidence,
          skippedOrchestrator: true,
          classifierCostUsd: classification.costUsd,
        };
      }
      this.logger.warn({
        msg: 'classifier_suggested_agent_not_found',
        suggested: classification.suggestedAgent,
      });
    }

    // 5. Fallback pro orchestrator
    const fallback = await this.fallbackToOrchestrator(conversation);
    if (fallback) {
      fallback.classifiedIntent = classification.intent;
      fallback.classifierConfidence = classification.confidence;
      fallback.classifierCostUsd = classification.costUsd;
    }
    return fallback;
  }

  private async fallbackToOrchestrator(
    conversation: Conversation,
  ): Promise<AgentSelection | null> {
    const link = await this.prisma.aiAgentChannel.findFirst({
      where: {
        channelId: conversation.channelId,
        mode: 'AUTONOMOUS',
        agent: { isActive: true, deletedAt: null },
      },
      include: {
        agent: { select: { id: true, name: true } },
      },
    });
    if (!link?.agent) {
      this.logger.warn({
        msg: 'no_orchestrator_for_channel',
        channelId: conversation.channelId,
      });
      return null;
    }
    return {
      agentId: link.agent.id,
      agentName: link.agent.name,
      classifiedIntent: null,
      classifierConfidence: null,
      skippedOrchestrator: false,
      classifierCostUsd: 0,
    };
  }

  /**
   * Decides whether the AI should react to an inbound message. Returns
   * `null` if it should not, or the resolved active agent for the run.
   * The runner does the actual execution.
   */
  async shouldHandle(
    conversation: Conversation & { isGroup?: boolean; aiAllowedInGroup?: boolean },
    message?: { content: any; metadata?: any },
  ): Promise<{
    handle: boolean;
    reason?: string;
  }> {
    // Hierarquia de override (mais específico ganha):
    //   conv.aiEnabled (true/false) — força resposta da conversa específica
    //   channel.aiEnabled (true/false) — força no canal inteiro
    //   org.aiEnabled (true/false) — global
    // Qualquer "false" mais específico bloqueia mesmo se mais genérico está ON.
    // "true" mais específico libera mesmo se mais genérico está OFF.

    // S22.2 — Panic mode é a PRIMEIRA coisa. Override absoluto: ignora scope,
    // conv override, channel override, tudo. Kill switch de emergência.
    const orgPanic = await this.prisma.organization.findUnique({
      where: { id: conversation.organizationId },
      select: { aiPanicMode: true },
    });
    if (orgPanic?.aiPanicMode) {
      return { handle: false, reason: 'ORG_PANIC_MODE' };
    }

    const convOverride = conversation.aiEnabled;

    if (convOverride === false) {
      return { handle: false, reason: 'conversation.aiEnabled=force-off' };
    }

    // S22 — Group gate: em grupos, exige whitelist + @ mention/reply
    if ((conversation as any).isGroup) {
      if (!(conversation as any).aiAllowedInGroup) {
        return { handle: false, reason: 'GROUP_NOT_WHITELISTED' };
      }
      if (!message) {
        // chamado sem mensagem (caller errado) — fail-closed
        return { handle: false, reason: 'GROUP_NO_MENTION' };
      }
      const candidates = await this.prisma.aiAgent.findMany({
        where: {
          organizationId: conversation.organizationId,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true, mentionHandle: true },
      });
      const matched = await this.groupMentionDetector.findMatchingAgent(
        message as any,
        candidates,
      );
      if (!matched) {
        return { handle: false, reason: 'GROUP_NO_MENTION' };
      }
      // Achou agente mencionado — bypassa pipeline scope (mention é mais forte)
      return { handle: true };
    }

    // S22 — Pipeline scope: se a conversa tem cards ativos em pipelines
    // scopados a algum agente, verifica se há match antes de prosseguir.
    // Conv com activeAgentId já definido bypassa (conversa em andamento).
    if (!conversation.activeAgentId) {
      const activeCards = await this.prisma.card.findMany({
        where: { conversationId: conversation.id, status: 'OPEN' },
        select: { pipelineId: true },
      });
      const activePipelineIds = Array.from(
        new Set(activeCards.map((c: any) => c.pipelineId).filter(Boolean) as string[]),
      );
      if (activePipelineIds.length > 0) {
        const matches = await this.prisma.aiAgent.findMany({
          where: {
            organizationId: conversation.organizationId,
            isActive: true,
            deletedAt: null,
            pipelineScope: { hasSome: activePipelineIds },
          },
          select: { id: true },
        });
        if (matches.length > 0) {
          // Há agente com pipeline scope matching — pode prosseguir
          // (o selectAgent/route vai escolher qual agente atua)
        }
        // Se há pipelines ativos mas nenhum agente com scope compatível,
        // deixa prosseguir normalmente (fallback pro orchestrator genérico)
      }
    }

    // Carrega channel + org pra cascade de checks.
    const [channel, org] = await Promise.all([
      this.prisma.channel.findUnique({
        where: { id: conversation.channelId },
        select: { aiEnabled: true },
      }),
      this.prisma.organization.findUnique({
        where: { id: conversation.organizationId },
      }),
    ]);
    if (!org) return { handle: false, reason: 'org-not-found' };

    const channelOverride = channel?.aiEnabled;
    if (convOverride !== true && channelOverride === false) {
      return { handle: false, reason: 'channel.aiEnabled=force-off' };
    }

    if (convOverride !== true && channelOverride !== true) {
      // Sem override "ON" em conv nem channel → regras globais valem.
      if (!org.aiEnabled) {
        // S22.1 — scope explícito sobrevive ao kill switch geral.
        // Se o operador foi explicitamente scopar um agente a um pipeline,
        // esse é um sinal de intenção clara: o agente deve atuar nesse
        // contexto mesmo com a IA da org "desligada". O `org.aiEnabled=false`
        // passa a calar SÓ agentes genéricos (sem pipelineScope). Pra kill
        // switch absoluto: setar `agent.isActive = false` ou desabilitar
        // `aiAllowedInGroup` por grupo.
        const hasScopedAgent = await this.hasPipelineScopedAgentForConversation(
          conversation.organizationId,
          conversation.id,
        );
        if (!hasScopedAgent) {
          return { handle: false, reason: 'org.aiEnabled=false' };
        }
        // Caso contrário, continua — o route() vai escolher o agente scopado.
      }
      if (!this.isWithinBusinessHours(org)) {
        return { handle: false, reason: 'outside-business-hours' };
      }
    }

    // Mesmo com override pra ON, ainda precisa existir um agente ativo
    // pra atender essa conversa. Sem isso, não tem o que rodar.
    if (!conversation.activeAgentId) {
      const link = await this.prisma.aiAgentChannel.findFirst({
        where: {
          channelId: conversation.channelId,
          mode: 'AUTONOMOUS',
          agent: { isActive: true, deletedAt: null },
        },
      });
      if (!link) {
        return { handle: false, reason: 'no-agent-for-channel' };
      }
    }

    // Cap mensal vale sempre — proteção de orçamento, não dá pra furar.
    if (org.aiMonthlyTokenCap) {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const used = await this.prisma.aiAgentRun.aggregate({
        where: {
          organizationId: org.id,
          startedAt: { gte: startOfMonth },
        },
        _sum: { inputTokens: true, outputTokens: true },
      });
      const total =
        (used._sum.inputTokens ?? 0) + (used._sum.outputTokens ?? 0);
      if (total >= org.aiMonthlyTokenCap) {
        return { handle: false, reason: 'monthly-token-cap-reached' };
      }
    }

    return { handle: true };
  }

  /**
   * S22.1 — Checa se a conversa tem cards ativos em pipelines scopados por
   * algum agente. Usado pra deixar agentes scopados sobreviverem ao
   * `org.aiEnabled=false` (kill switch geral). A intenção explícita do
   * operador (scopar um agente a um pipeline) vale mais que o switch global.
   */
  private async hasPipelineScopedAgentForConversation(
    organizationId: string,
    conversationId: string,
  ): Promise<boolean> {
    const activeCards = await this.prisma.card.findMany({
      where: { conversationId, status: 'OPEN' },
      select: { pipelineId: true },
    });
    const pipelineIds = Array.from(
      new Set(activeCards.map((c) => c.pipelineId).filter(Boolean) as string[]),
    );
    if (pipelineIds.length === 0) return false;
    const match = await this.prisma.aiAgent.findFirst({
      where: {
        organizationId,
        isActive: true,
        deletedAt: null,
        pipelineScope: { hasSome: pipelineIds },
      },
      select: { id: true },
    });
    return !!match;
  }

  private isWithinBusinessHours(org: Organization): boolean {
    if (!org.aiBusinessHours) return true; // 24/7 default

    const config = org.aiBusinessHours as unknown as BusinessHoursConfig;
    const tz = org.aiTimezone || 'America/Sao_Paulo';

    // Get day-of-week + HH:mm in the org's tz.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const weekday = parts
      .find((p) => p.type === 'weekday')
      ?.value.toLowerCase() ?? '';
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const nowMinutes = parseInt(hour, 10) * 60 + parseInt(minute, 10);

    if (!DAY_KEYS.includes(weekday as (typeof DAY_KEYS)[number])) {
      return true;
    }
    const day = config[weekday];
    if (!day || !day.enabled) return false;

    const windows = day.windows ?? [];
    if (windows.length === 0) return true;

    return windows.some(([from, to]) => {
      const fromMin = this.parseHourToMinutes(from);
      const toMin = this.parseHourToMinutes(to);
      return nowMinutes >= fromMin && nowMinutes < toMin;
    });
  }

  private parseHourToMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
    return (h || 0) * 60 + (m || 0);
  }
}
