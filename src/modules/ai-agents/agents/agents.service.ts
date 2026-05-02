import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AiAgentMode, AiAgentTrigger } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AssignAgentChannelDto } from './dto/assign-channel.dto';

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, dto: CreateAgentDto) {
    return this.prisma.aiAgent.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description,
        avatarUrl: dto.avatarUrl,
        kind: dto.kind ?? 'WORKER',
        category: dto.category,
        capabilities: dto.capabilities ?? [],
        modelId: dto.modelId,
        modelParams: dto.modelParams as object | undefined,
        systemPrompt: dto.systemPrompt,
        temperature: dto.temperature ?? 0.7,
        maxTokens: dto.maxTokens ?? 2048,
        canRespondDirectly: dto.canRespondDirectly ?? true,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async list(organizationId: string) {
    return this.prisma.aiAgent.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      include: {
        channels: {
          include: {
            channel: { select: { id: true, name: true, type: true } },
          },
        },
      },
    });
  }

  async findOne(organizationId: string, id: string) {
    const agent = await this.prisma.aiAgent.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: {
        channels: {
          include: {
            channel: { select: { id: true, name: true, type: true } },
          },
        },
      },
    });
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  async update(organizationId: string, id: string, dto: UpdateAgentDto) {
    await this.findOne(organizationId, id);
    return this.prisma.aiAgent.update({
      where: { id },
      data: {
        ...dto,
        modelParams: dto.modelParams as object | undefined,
      },
    });
  }

  async softDelete(organizationId: string, id: string) {
    await this.findOne(organizationId, id);
    await this.prisma.aiAgent.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async assignChannel(
    organizationId: string,
    agentId: string,
    dto: AssignAgentChannelDto,
  ) {
    await this.findOne(organizationId, agentId);

    const channel = await this.prisma.channel.findFirst({
      where: { id: dto.channelId, organizationId, deletedAt: null },
    });
    if (!channel) {
      throw new BadRequestException('Channel not found in this organization');
    }

    return this.prisma.aiAgentChannel.upsert({
      where: {
        agentId_channelId: { agentId, channelId: dto.channelId },
      },
      update: {
        mode: dto.mode ?? AiAgentMode.AUTONOMOUS,
        trigger: dto.trigger ?? AiAgentTrigger.ALWAYS,
      },
      create: {
        agentId,
        channelId: dto.channelId,
        mode: dto.mode ?? AiAgentMode.AUTONOMOUS,
        trigger: dto.trigger ?? AiAgentTrigger.ALWAYS,
      },
    });
  }

  async unassignChannel(
    organizationId: string,
    agentId: string,
    channelId: string,
  ) {
    await this.findOne(organizationId, agentId);
    await this.prisma.aiAgentChannel.deleteMany({
      where: { agentId, channelId },
    });
  }

  async listRuns(organizationId: string, agentId: string, limit = 50) {
    await this.findOne(organizationId, agentId);
    return this.prisma.aiAgentRun.findMany({
      where: { agentId, organizationId },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { toolCalls: true },
    });
  }

  // ─── Jarvis stats ─────────────────────────────────────────────

  /**
   * Returns org-wide aggregates over a time window: total runs, success/fail
   * counts, costs, tokens, latency p50/p95, breakdowns by model, tool, and
   * handoff. Used by the "Visão Geral" tab.
   */
  async getOrgStats(organizationId: string, period: '24h' | '7d' | '30d') {
    const since = this.windowStart(period);

    const [
      runs,
      monthlyTokensUsed,
      org,
      toolStats,
      handoffStats,
    ] = await Promise.all([
      this.prisma.aiAgentRun.findMany({
        where: { organizationId, startedAt: { gte: since } },
        select: {
          id: true,
          agentId: true,
          modelId: true,
          status: true,
          finalAction: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          costUsd: true,
          durationMs: true,
        },
      }),
      this.aggregateMonthlyTokens(organizationId),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { aiMonthlyTokenCap: true },
      }),
      this.prisma.aiToolCall.groupBy({
        by: ['toolName'],
        where: { run: { organizationId, startedAt: { gte: since } } },
        _count: { _all: true },
      }),
      this.prisma.aiAgentHandoff.findMany({
        where: {
          conversation: { organizationId },
          createdAt: { gte: since },
        },
        select: { fromAgentId: true, toAgentId: true },
      }),
    ]);

    const total = runs.length;
    const completed = runs.filter((r) => r.status === 'COMPLETED').length;
    const failed = runs.filter((r) => r.status === 'FAILED').length;
    const skipped = runs.filter((r) => r.status === 'SKIPPED').length;

    const inputTokens = sum(runs, (r) => r.inputTokens);
    const outputTokens = sum(runs, (r) => r.outputTokens);
    const cacheReadTokens = sum(runs, (r) => r.cacheReadTokens);
    const cacheWriteTokens = sum(runs, (r) => r.cacheWriteTokens);
    const costUsd = runs.reduce(
      (acc, r) => acc + Number(r.costUsd || 0),
      0,
    );

    const durations = runs
      .map((r) => r.durationMs)
      .filter((d): d is number => typeof d === 'number')
      .sort((a, b) => a - b);

    const byModel = groupSum(runs, (r) => r.modelId, (r) => ({
      runs: 1,
      tokens: r.inputTokens + r.outputTokens,
      cost: Number(r.costUsd || 0),
    }));

    const byFinalAction = groupCount(runs, (r) => r.finalAction || 'NONE');
    const byAgent = groupSum(runs, (r) => r.agentId, (r) => ({
      runs: 1,
      tokens: r.inputTokens + r.outputTokens,
      cost: Number(r.costUsd || 0),
    }));

    const handoffPairs = groupCount(
      handoffStats,
      (h) => `${h.fromAgentId ?? 'system'}::${h.toAgentId}`,
    );

    return {
      period,
      since: since.toISOString(),
      runs: {
        total,
        completed,
        failed,
        skipped,
        successRate:
          total > 0 ? +((completed / total) * 100).toFixed(1) : null,
      },
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        total: inputTokens + outputTokens,
      },
      cost: {
        usd: +costUsd.toFixed(4),
        avgPerRun: total > 0 ? +(costUsd / total).toFixed(6) : 0,
      },
      latency: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
      },
      monthlyCap: {
        used: monthlyTokensUsed,
        cap: org?.aiMonthlyTokenCap ?? null,
        percentUsed:
          org?.aiMonthlyTokenCap && org.aiMonthlyTokenCap > 0
            ? +((monthlyTokensUsed / org.aiMonthlyTokenCap) * 100).toFixed(1)
            : null,
      },
      byModel: Object.entries(byModel).map(([modelId, v]) => ({
        modelId,
        ...v,
      })),
      byAgent: Object.entries(byAgent).map(([agentId, v]) => ({
        agentId,
        ...v,
      })),
      byFinalAction,
      tools: toolStats.map((t) => ({
        name: t.toolName,
        calls: t._count._all,
      })),
      handoffs: Object.entries(handoffPairs).map(([key, count]) => {
        const [fromAgentId, toAgentId] = key.split('::');
        return { fromAgentId, toAgentId, count };
      }),
    };
  }

  /** Single-agent stats with the same shape (minus byAgent breakdown). */
  async getAgentStats(
    organizationId: string,
    agentId: string,
    period: '24h' | '7d' | '30d',
  ) {
    await this.findOne(organizationId, agentId);
    const since = this.windowStart(period);

    const [runs, toolStats, handoffsOut, handoffsIn] = await Promise.all([
      this.prisma.aiAgentRun.findMany({
        where: { organizationId, agentId, startedAt: { gte: since } },
        select: {
          modelId: true,
          status: true,
          finalAction: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          costUsd: true,
          durationMs: true,
        },
      }),
      this.prisma.aiToolCall.groupBy({
        by: ['toolName'],
        where: {
          run: { organizationId, agentId, startedAt: { gte: since } },
        },
        _count: { _all: true },
      }),
      this.prisma.aiAgentHandoff.count({
        where: {
          fromAgentId: agentId,
          createdAt: { gte: since },
        },
      }),
      this.prisma.aiAgentHandoff.count({
        where: {
          toAgentId: agentId,
          fromAgentId: { not: agentId },
          createdAt: { gte: since },
        },
      }),
    ]);

    const total = runs.length;
    const completed = runs.filter((r) => r.status === 'COMPLETED').length;
    const failed = runs.filter((r) => r.status === 'FAILED').length;
    const inputTokens = sum(runs, (r) => r.inputTokens);
    const outputTokens = sum(runs, (r) => r.outputTokens);
    const costUsd = runs.reduce((a, r) => a + Number(r.costUsd || 0), 0);
    const durations = runs
      .map((r) => r.durationMs)
      .filter((d): d is number => typeof d === 'number')
      .sort((a, b) => a - b);

    return {
      period,
      since: since.toISOString(),
      runs: {
        total,
        completed,
        failed,
        successRate:
          total > 0 ? +((completed / total) * 100).toFixed(1) : null,
      },
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: sum(runs, (r) => r.cacheReadTokens),
        cacheWrite: sum(runs, (r) => r.cacheWriteTokens),
        total: inputTokens + outputTokens,
      },
      cost: {
        usd: +costUsd.toFixed(4),
        avgPerRun: total > 0 ? +(costUsd / total).toFixed(6) : 0,
      },
      latency: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
      },
      byFinalAction: groupCount(runs, (r) => r.finalAction || 'NONE'),
      byModel: Object.entries(
        groupSum(runs, (r) => r.modelId, (r) => ({
          runs: 1,
          tokens: r.inputTokens + r.outputTokens,
          cost: Number(r.costUsd || 0),
        })),
      ).map(([modelId, v]) => ({ modelId, ...v })),
      tools: toolStats.map((t) => ({
        name: t.toolName,
        calls: t._count._all,
      })),
      handoffs: { sent: handoffsOut, received: handoffsIn },
    };
  }

  /** Run feed for the org, optionally filtered by a single agent. */
  async listOrgRuns(
    organizationId: string,
    options: { agentId?: string; limit?: number },
  ) {
    return this.prisma.aiAgentRun.findMany({
      where: {
        organizationId,
        ...(options.agentId ? { agentId: options.agentId } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: options.limit ?? 50,
      include: {
        agent: { select: { id: true, name: true, kind: true } },
        toolCalls: { select: { toolName: true } },
      },
    });
  }

  // ─── private helpers ────────────────────────────────────────────

  private windowStart(period: '24h' | '7d' | '30d'): Date {
    const now = new Date();
    const ms = { '24h': 86400, '7d': 604800, '30d': 2592000 }[period] * 1000;
    return new Date(now.getTime() - ms);
  }

  private async aggregateMonthlyTokens(organizationId: string) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const agg = await this.prisma.aiAgentRun.aggregate({
      where: { organizationId, startedAt: { gte: startOfMonth } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    return (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
  }
}

// ─── pure helpers (top-level) ─────────────────────────────────────

function sum<T>(arr: T[], pick: (item: T) => number): number {
  return arr.reduce((acc, item) => acc + (pick(item) || 0), 0);
}

function groupCount<T>(arr: T[], key: (item: T) => string) {
  const out: Record<string, number> = {};
  for (const item of arr) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function groupSum<T, V extends Record<string, number>>(
  arr: T[],
  key: (item: T) => string,
  pick: (item: T) => V,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const item of arr) {
    const k = key(item);
    const v = pick(item);
    if (!out[k]) {
      out[k] = { ...v };
    } else {
      for (const field in v) {
        out[k][field] = ((out[k][field] || 0) + (v[field] || 0)) as V[typeof field];
      }
    }
  }
  return out;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}
