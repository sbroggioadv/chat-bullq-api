import { Injectable } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Conversation, Message } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { AgentRouterService } from '../router/agent-router.service';
import { AiAgentRunnerService } from './agent-runner.service';
import { isConversationalOrchestrator } from './conversational-orchestrator';

export const GROUP_NO_REPLY_QUEUE = 'ai-group-no-reply';

@Injectable()
export class GroupNoReplyService {
  private readonly tails = new Map<string, Promise<void>>();

  async runGuarded<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(conversationId, current);
    await previous;
    try { return await fn(); } finally {
      if (this.tails.get(conversationId) === current) this.tails.delete(conversationId);
      release();
    }
  }

  constructor(@InjectQueue(GROUP_NO_REPLY_QUEUE) private readonly queue: Queue, private readonly prisma: PrismaService) {}

  async schedule(conversation: Conversation, message: Message): Promise<void> {
    if (!conversation.isGroup) return;
    const raw = process.env.AI_GROUP_NO_REPLY_MINUTES?.trim().toLowerCase();
    if (raw === '0' || raw === 'off') return;
    const link = await this.prisma.aiAgentChannel.findFirst({
      where: { channelId: conversation.channelId, mode: 'AUTONOMOUS', agent: { organizationId: conversation.organizationId, kind: 'ORCHESTRATOR', isActive: true, deletedAt: null } },
      include: { agent: true }, orderBy: { createdAt: 'asc' },
    });
    if (!link || !isConversationalOrchestrator(link.agent)) return;
    const configured = Number(raw);
    const minutes = Number.isFinite(configured) && configured > 0 ? configured : 15;
    await this.queue.add('check', { conversationId: conversation.id, messageId: message.id, minutes }, {
      jobId: `group-no-reply-${message.id}`,
      delay: minutes * 60_000,
      attempts: 1,
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 7 * 86_400, count: 1_000 },
    });
  }
}

@Processor(GROUP_NO_REPLY_QUEUE)
export class GroupNoReplyProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService, private readonly router: AgentRouterService, private readonly runner: AiAgentRunnerService, private readonly groupNoReply: GroupNoReplyService) { super(); }

  async process(job: Job<{ conversationId: string; messageId: string; minutes: number }>) {
    const { conversationId, messageId, minutes } = job.data;
    const raw = process.env.AI_GROUP_NO_REPLY_MINUTES?.trim().toLowerCase();
    if (raw === '0' || raw === 'off') return;
    return this.groupNoReply.runGuarded(conversationId, () => this.processGuarded(conversationId, messageId, minutes));
  }

  private async processGuarded(conversationId: string, messageId: string, minutes: number) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || !conversation.isGroup || conversation.isArchived) return;
    const message = await this.prisma.message.findFirst({ where: { conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (!message || message.id !== messageId || message.direction !== 'INBOUND' || message.revokedAt) return;
    const decision = await this.router.shouldHandle(conversation, message);
    if (!decision.handle) return;
    const link = await this.prisma.aiAgentChannel.findFirst({
      where: { channelId: conversation.channelId, mode: 'AUTONOMOUS', agent: { organizationId: conversation.organizationId, kind: 'ORCHESTRATOR', isActive: true, deletedAt: null } },
      include: { agent: true }, orderBy: { createdAt: 'asc' },
    });
    if (!link || !isConversationalOrchestrator(link.agent) || (decision.scopedAgentIds && !decision.scopedAgentIds.includes(link.agent.id))) return;
    const latest = await this.prisma.message.findFirst({ where: { conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (!latest || latest.id !== messageId) return;
    await this.runner.run({ conversation, triggerMessage: message, forcedAgentId: conversation.activeAgentId || link.agent.id, persistActiveAgent: false, expectedLatestMessageId: messageId, contextNote: `Ninguém respondeu em ${minutes} minutos; responda só se for um pedido em que você possa ajudar. Cumprimento solto e conversa entre os membros continuam sem resposta.` });
  }
}
