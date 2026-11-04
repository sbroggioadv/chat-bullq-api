import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
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
  responsible: { select: { id: true, name: true, avatarUrl: true, organizations: { select: { organizationId: true } } } },
  tasks: { orderBy: { sortOrder: 'asc' as const } },
  attachments: { orderBy: { createdAt: 'desc' as const } },
  contacts: {
    include: {
      contact: { select: { id: true, name: true, phone: true, email: true, organizationId: true } },
    },
  },
  conversations: { select: { conversationId: true, conversation: { select: { organizationId: true } } } },
} as const;

type ProjectDetail = Prisma.ProjectGetPayload<{ include: typeof DETAIL_INCLUDE }>;

function emptyToNull(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length ? t : null;
}

function validateKind(metadata?: Record<string, unknown>) {
  if (metadata && 'kind' in metadata && metadata.kind !== 'PROJECT' && metadata.kind !== 'MENTORSHIP') {
    throw new BadRequestException('Tipo de projeto inválido');
  }
}

async function findGroupsByJids(db: Prisma.TransactionClient, organizationId: string, jids: string[]) {
  if (!jids.length) return [];
  return db.$queryRaw<{ id: string; channelId: string; jid: string }[]>`
    SELECT c.id, c.channel_id AS "channelId", cc.external_id AS jid
    FROM conversations c JOIN contact_channels cc
      ON cc.contact_id = c.contact_id AND cc.channel_id = c.channel_id
    WHERE c.organization_id = ${organizationId} AND c.deleted_at IS NULL AND c.is_group = true
      AND cc.external_id IN (${Prisma.join(jids)})
      AND cc.channel_id IN (SELECT id FROM channels WHERE organization_id = ${organizationId})`;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  toDetail(p: ProjectDetail) {
    const responsible = p.responsible?.organizations.some((o) => o.organizationId === p.organizationId)
      ? { id: p.responsible.id, name: p.responsible.name, avatarUrl: p.responsible.avatarUrl }
      : null;
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      groupJid: p.groupJid,
      hoppeId: p.hoppeId,
      responsibleUserId: responsible ? p.responsibleUserId : null,
      responsible,
      status: p.status ?? 'TODO',
      kind: (p.metadata as Record<string, unknown> | null)?.kind === 'MENTORSHIP' ? 'MENTORSHIP' : 'PROJECT',
      metadata: (p.metadata as Record<string, unknown>) ?? {},
      exists: true,
      conversationIds: p.conversations.filter((c) => c.conversation.organizationId === p.organizationId).map((c) => c.conversationId),
      tasks: p.tasks,
      attachments: p.attachments,
      contacts: p.contacts.filter((c) => c.contact.organizationId === p.organizationId).map((c) => ({
        id: c.id,
        contactId: c.contactId,
        name: c.contact.name,
        phone: c.contact.phone,
        email: c.contact.email,
      })),
    };
  }

  async create(organizationId: string, dto: CreateProjectDto) {
    if (dto.conversationId) {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: dto.conversationId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundException('Conversa não encontrada');
    }
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
    validateKind(dto.metadata);
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
    if (!conv) throw new NotFoundException('Conversa não encontrada');
    const linked = await this.prisma.projectConversation.findFirst({
      where: {
        conversationId,
        project: { organizationId, deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (linked) return this.getById(organizationId, linked.projectId);

    if (conv.isGroup) {
      const jid = deriveGroupJid(conv);
      if (jid) {
        const legacy = await this.prisma.project.findFirst({
          where: { organizationId, groupJid: jid, deletedAt: null },
          include: DETAIL_INCLUDE,
          orderBy: { updatedAt: 'desc' },
        });
        if (legacy) {
          await this.prisma.projectConversation.upsert({
            where: { uq_project_conversation: { projectId: legacy.id, conversationId } },
            create: { projectId: legacy.id, conversationId }, update: {},
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
      kind: 'PROJECT',
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
    validateKind(dto.metadata);
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

  async removeForConversation(organizationId: string, conversationId: string, projectId?: string, access: 'ALL' | Set<string> = new Set()) {
    return this.prisma.$transaction(async (tx) => {
      const conv = await tx.conversation.findFirst({
        where: { id: conversationId, organizationId, deletedAt: null },
        select: { id: true, isGroup: true, channelId: true, contact: { select: { channels: { select: { channelId: true, externalId: true } } } } },
      });
      if (!conv) throw new NotFoundException('Conversa não encontrada');
      if (access !== 'ALL' && !access.has(conv.channelId)) throw new ForbiddenException('You do not have access to this channel');
      const jid = conv.isGroup ? deriveGroupJid(conv) : null;
      const linked = await tx.projectConversation.findFirst({
        where: { conversationId, project: { organizationId, deletedAt: null }, ...(projectId ? { projectId } : {}) },
        orderBy: { createdAt: 'desc' },
      });
      const legacy = jid ? await tx.project.findFirst({
        where: { organizationId, deletedAt: null, groupJid: jid, ...(projectId ? { id: projectId } : {}) },
        orderBy: { updatedAt: 'desc' },
      }) : null;
      const targetId = linked?.projectId ?? legacy?.id;
      if (!targetId) throw new NotFoundException('Projeto não encontrado para a conversa');
      const project = await tx.project.findFirst({ where: { id: targetId, organizationId, deletedAt: null } });
      if (!project) throw new NotFoundException('Projeto não encontrado');
      let ids = [conversationId];
      if (jid) {
        const candidates = await findGroupsByJids(tx, organizationId, [jid]);
        ids = candidates.map(c => c.id);
      }
      const existing = await tx.projectConversation.findMany({ where: { projectId: targetId, conversationId: { in: ids } }, select: { conversationId: true } });
      const removed = project.groupJid === jid && jid ? ids.length : existing.length;
      await tx.projectConversation.deleteMany({ where: { projectId: targetId, conversationId: { in: ids } } });
      if (jid && project.groupJid === jid) await tx.project.update({ where: { id: targetId }, data: { groupJid: null } });
      const remaining = await tx.project.findFirst({
        where: { id: targetId, organizationId },
        select: { groupJid: true, _count: { select: { conversations: true, tasks: true, attachments: true } } },
      });
      if (remaining && !remaining.groupJid && !remaining._count.conversations && !remaining._count.tasks && !remaining._count.attachments) {
        await tx.project.update({ where: { id: targetId }, data: { deletedAt: new Date() } });
      }
      return { projectId: targetId, removedConversations: removed };
    });
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
      orderBy: { updatedAt: 'desc' },
    });
    for (const p of projects) {
      if (p.groupJid && !map.has(p.groupJid)) map.set(p.groupJid, this.toDetail(p));
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
    filter: { hoppeId?: string; responsibleUserId?: string; status?: string; kind?: 'ANY' | 'MENTORSHIP' },
  ): Promise<{ representativeIds: string[]; memberChannelIds: string[] }> {
    if (filter.kind) {
      const links = await this.prisma.projectConversation.findMany({
        where: { project: { organizationId, deletedAt: null }, conversation: { organizationId, deletedAt: null } },
        include: { project: { include: DETAIL_INCLUDE }, conversation: { select: { channelId: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const projects = await this.prisma.project.findMany({
        where: { organizationId, deletedAt: null, groupJid: { not: null } },
        include: DETAIL_INCLUDE, orderBy: { updatedAt: 'desc' },
      });
      const linked = new Map<string, { project: ReturnType<ProjectsService['toDetail']>; channelId: string }>();
      for (const link of links) if (!linked.has(link.conversationId)) linked.set(link.conversationId, { project: this.toDetail(link.project), channelId: link.conversation.channelId });
      const legacy = new Map<string, ReturnType<ProjectsService['toDetail']>>();
      for (const project of projects) if (project.groupJid && !legacy.has(project.groupJid)) legacy.set(project.groupJid, this.toDetail(project));
      const jids = [...legacy.keys()];
      const groups = await findGroupsByJids(this.prisma, organizationId, jids);
      for (const group of groups) {
        const project = legacy.get(group.jid);
        if (project && !linked.has(group.id)) linked.set(group.id, { project, channelId: group.channelId });
      }
      const selected = [...linked].filter(([, { project }]) =>
        (filter.kind !== 'MENTORSHIP' || project.kind === 'MENTORSHIP') &&
        (!filter.hoppeId || project.hoppeId === filter.hoppeId) &&
        (!filter.responsibleUserId || project.responsibleUserId === filter.responsibleUserId) &&
        (!filter.status || project.status === filter.status));
      return { representativeIds: selected.map(([id]) => id), memberChannelIds: [...new Set(selected.map(([, value]) => value.channelId))] };
    }
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
    const result = await this.prisma.projectTask.deleteMany({ where: { id: taskId, projectId } });
    if (!result.count) throw new NotFoundException('Task não encontrada');
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
    const result = await this.prisma.projectAttachment.deleteMany({
      where: { id: attachmentId, projectId },
    });
    if (!result.count) throw new NotFoundException('Anexo não encontrado');
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
    const result = await this.prisma.projectContact.deleteMany({
      where: { id: linkId, projectId },
    });
    if (!result.count) throw new NotFoundException('Contato do projeto não encontrado');
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
