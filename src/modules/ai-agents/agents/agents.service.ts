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
}
