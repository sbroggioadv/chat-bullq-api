import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { deriveGroupJid } from '../segments/group-jid.util';
import { EmailService } from '../email/email.service';
import {
  AddContactDto,
  AttachMessageDto,
  CreateProjectDto,
  CreateTaskDto,
  ProjectEmailDto,
  PROJECT_PHASES,
  UpdateProjectDto,
  UpdateTaskDto,
} from './dto/project.dto';

const DETAIL_INCLUDE = {
  responsible: { select: { id: true, name: true, avatarUrl: true } },
  tasks: { orderBy: { sortOrder: 'asc' as const } },
  attachments: { orderBy: { createdAt: 'desc' as const } },
  contacts: {
    include: {
      contact: { select: { id: true, name: true, phone: true, email: true } },
    },
  },
  conversations: { select: { conversationId: true } },
} as const;

type ProjectDetail = Prisma.ProjectGetPayload<{ include: typeof DETAIL_INCLUDE }>;

function emptyToNull(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length ? t : null;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  toDetail(p: ProjectDetail) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      groupJid: p.groupJid,
      hoppeId: p.hoppeId,
      responsibleUserId: p.responsibleUserId,
      responsible: p.responsible,
      status: p.status ?? 'TODO',
      metadata: (p.metadata as Record<string, unknown>) ?? {},
      exists: true,
      conversationIds: p.conversations.map((c) => c.conversationId),
      tasks: p.tasks,
      attachments: p.attachments,
      contacts: p.contacts.map((c) => ({
        id: c.id,
        contactId: c.contactId,
        name: c.contact.name,
        phone: c.contact.phone,
        email: c.contact.email,
      })),
    };
  }

  async create(organizationId: string, dto: CreateProjectDto) {
    const project = await this.prisma.project.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        status: dto.status && PROJECT_PHASES.includes(dto.status as any)
          ? dto.status
          : 'TODO',
      },
      include: DETAIL_INCLUDE,
    });
    if (dto.conversationId) {
      await this.linkConversation(organizationId, project.id, dto.conversationId);
    }
    return this.getById(organizationId, project.id);
  }

  async list(
    organizationId: string,
    filter: {
      status?: string;
      search?: string;
      responsibleUserId?: string;
      hoppeId?: string;
    },
  ) {
    const where: Prisma.ProjectWhereInput = { organizationId, deletedAt: null };
    if (filter.status) where.status = filter.status;
    if (filter.responsibleUserId) where.responsibleUserId = filter.responsibleUserId;
    if (filter.hoppeId) where.hoppeId = filter.hoppeId;
    if (filter.search?.trim()) {
      where.OR = [
        { name: { contains: filter.search.trim(), mode: 'insensitive' } },
        { description: { contains: filter.search.trim(), mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.project.findMany({
      where,
      include: DETAIL_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((p) => this.toDetail(p));
  }

  async filters(organizationId: string) {
    const rows = await this.prisma.project.findMany({
      where: { organizationId, deletedAt: null },
      select: { status: true },
    });
    const statuses = Array.from(
      new Set(rows.map((r) => r.status).filter((s): s is string => !!s)),
    );
    return { hoppeIds: [] as string[], statuses };
  }

  async getById(organizationId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: DETAIL_INCLUDE,
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return this.toDetail(project);
  }

  async update(organizationId: string, id: string, dto: UpdateProjectDto) {
    await this.getById(organizationId, id);
    if (dto.responsibleUserId) {
      const member = await this.prisma.userOrganization.findFirst({
        where: { organizationId, userId: dto.responsibleUserId },
      });
      if (!member) {
        throw new BadRequestException('Responsável precisa ser membro da organização');
      }
    }
    if (dto.status && !PROJECT_PHASES.includes(dto.status as any) && dto.status !== '') {
      throw new BadRequestException(`Fase inválida: ${dto.status}`);
    }
    const existing = await this.prisma.project.findUnique({ where: { id } });
    const mergedMetadata =
      dto.metadata !== undefined
        ? {
            ...((existing?.metadata as Record<string, unknown>) ?? {}),
            ...dto.metadata,
          }
        : undefined;
    await this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: emptyToNull(dto.description) }
          : {}),
        ...(dto.hoppeId !== undefined ? { hoppeId: emptyToNull(dto.hoppeId) } : {}),
        ...(dto.responsibleUserId !== undefined
          ? { responsibleUserId: emptyToNull(dto.responsibleUserId) }
          : {}),
        ...(dto.status !== undefined ? { status: emptyToNull(dto.status) ?? 'TODO' } : {}),
        ...(mergedMetadata !== undefined
          ? { metadata: mergedMetadata as Prisma.InputJsonValue }
          : {}),
      },
    });
    return this.getById(organizationId, id);
  }

  async getForConversation(organizationId: string, conversationId: string) {
    const linked = await this.prisma.projectConversation.findFirst({
      where: {
        conversationId,
        project: { organizationId, deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (linked) return this.getById(organizationId, linked.projectId);

    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, deletedAt: null },
      select: {
        isGroup: true,
        channelId: true,
        contact: {
          select: { name: true, channels: { select: { channelId: true, externalId: true } } },
        },
      },
    });
    if (conv?.isGroup) {
      const jid = deriveGroupJid(conv);
      if (jid) {
        const legacy = await this.prisma.project.findFirst({
          where: { organizationId, groupJid: jid, deletedAt: null },
          include: DETAIL_INCLUDE,
        });
        if (legacy) {
          await this.prisma.projectConversation.upsert({
            where: {
              uq_project_conversation: { projectId: legacy.id, conversationId },
            },
            create: { projectId: legacy.id, conversationId },
            update: {},
          });
          return this.toDetail(legacy);
        }
      }
    }
    return {
      id: null,
      name: '',
      description: null,
      groupJid: null,
      hoppeId: null,
      responsibleUserId: null,
      responsible: null,
      status: 'TODO',
      metadata: {},
      exists: false,
      conversationIds: [] as string[],
      tasks: [],
      attachments: [],
      contacts: [],
    };
  }

  async updateForConversation(
    organizationId: string,
    conversationId: string,
    dto: UpdateProjectDto,
  ) {
    const current = await this.getForConversation(organizationId, conversationId);
    if (current.exists && current.id) {
      return this.update(organizationId, current.id, dto);
    }
    const created = await this.create(organizationId, {
      name: dto.name?.trim() || 'Novo projeto',
      description: dto.description,
      status: dto.status,
      conversationId,
    });
    if (dto.status || dto.responsibleUserId || dto.hoppeId || dto.metadata) {
      return this.update(organizationId, created.id, dto);
    }
    return created;
  }

  async linkConversation(
    organizationId: string,
    projectId: string,
    conversationId: string,
  ) {
    await this.getById(organizationId, projectId);
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, deletedAt: null },
    });
    if (!conv) throw new NotFoundException('Conversa não encontrada');
    await this.prisma.projectConversation.upsert({
      where: { uq_project_conversation: { projectId, conversationId } },
      create: { projectId, conversationId },
      update: {},
    });
    const contactId = conv.contactId;
    if (contactId) {
      await this.prisma.projectContact.upsert({
        where: { uq_project_contact: { projectId, contactId } },
        create: { projectId, contactId },
        update: {},
      });
    }
    return this.getById(organizationId, projectId);
  }

  async attachByJids(organizationId: string, jids: string[]) {
    const map = new Map<string, ReturnType<ProjectsService['toDetail']>>();
    const unique = Array.from(new Set(jids));
    if (!unique.length) return map;
    const projects = await this.prisma.project.findMany({
      where: { organizationId, groupJid: { in: unique }, deletedAt: null },
      include: DETAIL_INCLUDE,
    });
    for (const p of projects) {
      if (p.groupJid) map.set(p.groupJid, this.toDetail(p));
    }
    return map;
  }

  async attachByConversationIds(organizationId: string, conversationIds: string[]) {
    const map = new Map<string, ReturnType<ProjectsService['toDetail']>>();
    const unique = Array.from(new Set(conversationIds));
    if (!unique.length) return map;
    const links = await this.prisma.projectConversation.findMany({
      where: {
        conversationId: { in: unique },
        project: { organizationId, deletedAt: null },
      },
      include: { project: { include: DETAIL_INCLUDE } },
      orderBy: { createdAt: 'desc' },
    });
    for (const link of links) {
      if (!map.has(link.conversationId)) {
        map.set(link.conversationId, this.toDetail(link.project));
      }
    }
    return map;
  }

  async resolveFilter(
    organizationId: string,
    filter: { hoppeId?: string; responsibleUserId?: string; status?: string },
  ): Promise<{ representativeIds: string[]; memberChannelIds: string[] }> {
    const where: Prisma.ProjectWhereInput = { organizationId, deletedAt: null };
    if (filter.hoppeId) where.hoppeId = filter.hoppeId;
    if (filter.responsibleUserId) where.responsibleUserId = filter.responsibleUserId;
    if (filter.status) where.status = filter.status;
    const projects = await this.prisma.project.findMany({
      where,
      select: {
        conversations: { select: { conversationId: true, conversation: { select: { channelId: true } } } },
      },
    });
    const ids = new Set<string>();
    const channels = new Set<string>();
    for (const p of projects) {
      for (const link of p.conversations) {
        ids.add(link.conversationId);
        channels.add(link.conversation.channelId);
      }
    }
    return {
      representativeIds: Array.from(ids),
      memberChannelIds: Array.from(channels),
    };
  }

  async addTask(organizationId: string, projectId: string, dto: CreateTaskDto) {
    await this.getById(organizationId, projectId);
    const last = await this.prisma.projectTask.aggregate({
      where: { projectId },
      _max: { sortOrder: true },
    });
    await this.prisma.projectTask.create({
      data: {
        projectId,
        title: dto.title.trim(),
        sortOrder: (last._max.sortOrder ?? 0) + 1,
      },
    });
    return this.getById(organizationId, projectId);
  }

  async updateTask(
    organizationId: string,
    projectId: string,
    taskId: string,
    dto: UpdateTaskDto,
  ) {
    await this.getById(organizationId, projectId);
    const task = await this.prisma.projectTask.findFirst({
      where: { id: taskId, projectId },
    });
    if (!task) throw new NotFoundException('Task não encontrada');
    await this.prisma.projectTask.update({
      where: { id: taskId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.done !== undefined ? { done: dto.done } : {}),
      },
    });
    return this.getById(organizationId, projectId);
  }

  async removeTask(organizationId: string, projectId: string, taskId: string) {
    await this.getById(organizationId, projectId);
    await this.prisma.projectTask.deleteMany({ where: { id: taskId, projectId } });
    return this.getById(organizationId, projectId);
  }

  async attachMessage(
    organizationId: string,
    projectId: string,
    dto: AttachMessageDto,
    actorUserId?: string,
  ) {
    await this.getById(organizationId, projectId);
    const message = await this.prisma.message.findFirst({
      where: {
        id: dto.messageId,
        conversation: { organizationId, deletedAt: null },
      },
      include: { conversation: { select: { id: true } } },
    });
    if (!message) throw new NotFoundException('Mensagem não encontrada');
    const content = (message.content ?? {}) as Record<string, unknown>;
    const fileName =
      (typeof content.fileName === 'string' && content.fileName) ||
      (typeof content.filename === 'string' && content.filename) ||
      null;
    const url =
      (typeof content.url === 'string' && content.url) ||
      (typeof content.mediaUrl === 'string' && content.mediaUrl) ||
      null;
    const preview =
      (typeof content.text === 'string' && content.text.slice(0, 240)) ||
      (typeof content.caption === 'string' && content.caption.slice(0, 240)) ||
      `[${message.type}]`;
    await this.prisma.projectAttachment.create({
      data: {
        projectId,
        messageId: message.id,
        conversationId: message.conversationId,
        label: fileName || preview,
        fileName,
        mimeType: typeof content.mimeType === 'string' ? content.mimeType : null,
        url,
        preview,
        createdById: actorUserId ?? null,
      },
    });
    await this.linkConversation(organizationId, projectId, message.conversationId);
    return this.getById(organizationId, projectId);
  }

  async removeAttachment(organizationId: string, projectId: string, attachmentId: string) {
    await this.getById(organizationId, projectId);
    await this.prisma.projectAttachment.deleteMany({
      where: { id: attachmentId, projectId },
    });
    return this.getById(organizationId, projectId);
  }

  async addContact(organizationId: string, projectId: string, dto: AddContactDto) {
    await this.getById(organizationId, projectId);
    const contact = await this.prisma.contact.findFirst({
      where: { id: dto.contactId, organizationId, deletedAt: null },
    });
    if (!contact) throw new NotFoundException('Contato não encontrado');
    await this.prisma.projectContact.upsert({
      where: { uq_project_contact: { projectId, contactId: dto.contactId } },
      create: { projectId, contactId: dto.contactId },
      update: {},
    });
    return this.getById(organizationId, projectId);
  }

  async removeContact(organizationId: string, projectId: string, linkId: string) {
    await this.getById(organizationId, projectId);
    await this.prisma.projectContact.deleteMany({
      where: { id: linkId, projectId },
    });
    return this.getById(organizationId, projectId);
  }

  async emailParticipants(
    organizationId: string,
    projectId: string,
    dto: ProjectEmailDto,
  ) {
    const project = await this.getById(organizationId, projectId);
    const fromContacts = project.contacts
      .map((c) => c.email)
      .filter((e): e is string => !!e && e.includes('@'));
    const extra = (dto.to || '')
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.includes('@'));
    const to = Array.from(new Set([...fromContacts, ...extra]));
    if (!to.length) {
      throw new BadRequestException(
        'Nenhum e-mail nos envolvidos. Inclua um destinatário ou cadastre e-mail no contato.',
      );
    }
    const status = await this.email.status(organizationId, 'ALL');
    const channelId = status.channels[0]?.id;
    if (!channelId) {
      throw new BadRequestException('Nenhum Gmail conectado. Conecte em Canais.');
    }
    return this.email.compose(organizationId, 'ALL', {
      channelId,
      to: to.join(', '),
      subject: dto.subject,
      body: dto.body,
    });
  }
}
