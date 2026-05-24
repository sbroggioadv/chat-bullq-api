import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { AiAgent } from '@prisma/client';

export type CadenceReason = 'OK' | 'CHANNEL_CAP_HOUR' | 'CONV_CONSECUTIVE_CAP';

export interface CadenceDecision {
  shouldSend: boolean;
  delayMs: number;
  reason: CadenceReason;
}

/**
 * Decide quando uma resposta IA deve ser enviada — não decide se a IA
 * DEVE responder (isso é o AgentRouter), mas SE/QUANDO ela pode mandar
 * a resposta já gerada pelo LLM.
 *
 * Aplica 2 caps duros + 1 delay humanizado:
 *  - Cap horário do canal: max N msgs IA / canal / hora rolante
 *  - Cap consecutivo da conversa: max N msgs IA seguidas sem inbound
 *  - Delay humanizado: simula leitura + pensamento + digitação
 */
@Injectable()
export class AgentCadenceController {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(
    channelId: string,
    conversationId: string,
    agent: Pick<AiAgent, 'id' | 'rateLimitPerHour' | 'consecutiveMsgCap' | 'humanizationEnabled' | 'minDelayMs'>,
    responseText: string,
    inboundText: string,
  ): Promise<CadenceDecision> {
    // 1) Cap horário do canal
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const hourCount = await this.prisma.aiResponseLog.count({
      where: { channelId, sentAt: { gte: oneHourAgo } },
    });
    if (hourCount >= agent.rateLimitPerHour) {
      return { shouldSend: false, delayMs: 0, reason: 'CHANNEL_CAP_HOUR' };
    }

    // 2) Cap consecutivo da conversa
    const lastInbound = await this.prisma.message.findFirst({
      where: { conversationId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const consecutiveAi = await this.prisma.message.count({
      where: {
        conversationId,
        direction: 'OUTBOUND',
        senderId: null,
        ...(lastInbound ? { createdAt: { gt: lastInbound.createdAt } } : {}),
      },
    });
    if (consecutiveAi >= agent.consecutiveMsgCap) {
      return { shouldSend: false, delayMs: 0, reason: 'CONV_CONSECUTIVE_CAP' };
    }

    // 3) Delay humanizado
    const delayMs = this.computeDelay(agent, responseText, inboundText);
    return { shouldSend: true, delayMs, reason: 'OK' };
  }

  private computeDelay(
    agent: Pick<AiAgent, 'humanizationEnabled' | 'minDelayMs'>,
    responseText: string,
    inboundText: string,
  ): number {
    if (!agent.humanizationEnabled) {
      return agent.minDelayMs;
    }
    // Reading: 3-12s baseado no tamanho do inbound
    const reading_ms = Math.min(3000 + inboundText.length * 50, 12000);
    // Thinking: 5-20s aleatório (jitter)
    const thinking_ms = 5000 + Math.floor(Math.random() * 15000);
    // Typing: ~60wpm = ~220 chars/min → cap 60s
    const typing_ms = Math.min(
      (responseText.length / 5) * (60_000 / 220),
      60_000,
    );
    const base = Math.floor(reading_ms + thinking_ms + typing_ms);
    return Math.max(base, agent.minDelayMs);
  }
}
