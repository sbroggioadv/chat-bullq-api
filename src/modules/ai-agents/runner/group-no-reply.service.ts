import { Injectable } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Conversation, Message } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { AgentRouterService } from '../router/agent-router.service';
import { AiAgentRunnerService } from './agent-runner.service';

export const GROUP_NO_REPLY_QUEUE = 'ai-group-no-reply';

@Injectable()
export class GroupNoReplyService {
  constructor(@InjectQueue(GROUP_NO_REPLY_QUEUE) private readonly queue: Queue) {}

  async schedule(conversation: Conversation, message: Message): Promise<void> {
    if (!conversation.isGroup) return;
    const configured = Number(process.env.AI_GROUP_NO_REPLY_MINUTES);
    const minutes = Number.isFinite(configured) && configured > 0 ? configured : 15;
    await this.queue.add('check', { conversationId: conversation.id, messageId: message.id, minutes }, {
      jobId: `group-no-reply-${message.id}`,
      delay: minutes * 60_000,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
  }
}

@Processor(GROUP_NO_REPLY_QUEUE)
export class GroupNoReplyProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService, private readonly router: AgentRouterService, private readonly runner: AiAgentRunnerService) { super(); }

  async process(job: Job<{ conversationId: string; messageId: string; minutes: number }>) {
    const { conversationId, messageId, minutes } = job.data;
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || !conversation.isGroup || conversation.isArchived) return;
    const message = await this.prisma.message.findFirst({ where: { conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (!message || message.id !== messageId || message.direction !== 'INBOUND') return;
    const decision = await this.router.shouldHandle(conversation, message);
    if (!decision.handle) return;
    const link = await this.prisma.aiAgentChannel.findFirst({
      where: { channelId: conversation.channelId, mode: 'AUTONOMOUS', agent: { organizationId: conversation.organizationId, kind: 'ORCHESTRATOR', isActive: true, deletedAt: null } },
      include: { agent: true }, orderBy: { createdAt: 'asc' },
    });
    if (!link || (decision.scopedAgentIds && !decision.scopedAgentIds.includes(link.agent.id))) return;
    const latest = await this.prisma.message.findFirst({ where: { conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (!latest || latest.id !== messageId) return;
    await this.runner.run({ conversation, triggerMessage: message, forcedAgentId: link.agent.id, contextNote: `Ninguém respondeu em ${minutes} minutos; responda se puder ajudar.` });
  }
}
