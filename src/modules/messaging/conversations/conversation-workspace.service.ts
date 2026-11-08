import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InternalNote, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAccess, ChannelAccessService } from '../../iam/channel-access/channel-access.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { IdempotencyService } from '../pipeline/idempotency.service';
import { assertNotMergedExtra, findFirstNotMerged } from './merged-conversation';

@Injectable()
export class ConversationWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessService,
    private readonly realtime: RealtimeGateway,
    private readonly locks: IdempotencyService,
  ) {}

  private async conversation(id: string, organizationId: string, access: ChannelAccess) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, organizationId, deletedAt: null, channel: { deletedAt: null }, contact: { organizationId, deletedAt: null } },
      include: { contact: true },
    });
    if (!conv || conv.organizationId !== organizationId) throw new NotFoundException('Conversa não encontrada');
    this.channelAccess.assertChannelAccess(access, conv.channelId);
    assertNotMergedExtra(conv, 'workspace');
    return conv;
  }

  async mute(id: string, org: string, actorId: string, access: ChannelAccess, mode: unknown) {
    const conv = await this.conversation(id, org, access);
    const hours: Record<string, number> = { '1h': 1, '8h': 8, '24h': 24 };
    if (typeof mode !== 'string' || !['1h', '8h', '24h', 'forever', 'off'].includes(mode)) {
      throw new BadRequestException('Modo de silêncio inválido');
    }
    const mutedUntil = mode === 'off' ? null : mode === 'forever'
      ? new Date('9999-12-31T23:59:59Z') : new Date(Date.now() + hours[mode] * 3600000);
    const updated = await this.prisma.$transaction(async tx => {
      const updated = await tx.conversation.update({ where: { id, organizationId: org }, data: { mutedUntil } });
      await tx.conversationAuditLog.create({ data: { conversationId: id, actorId, action: 'MUTE_UPDATED', metadata: { mode, mutedUntil: mutedUntil?.toISOString() ?? null } } });
      return updated;
    });
    this.realtime.emitToChannel(conv.channelId, 'conversation:updated', { conversation: updated });
    this.realtime.emitToConversation(id, 'conversation:updated', { conversation: updated });
    return { id, mutedUntil: mutedUntil?.toISOString() ?? null };
  }

  private content(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) {
      throw new BadRequestException('A nota deve conter entre 1 e 4000 caracteres');
    }
    return value.trim();
  }

  private async withAuthors(notes: InternalNote[], org: string) {
    if (!notes.length) return [];
    const authors = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(notes.map(n => n.authorId))] }, organizations: { some: { organizationId: org } } },
      select: { id: true, name: true },
    });
    const names = new Map(authors.map(a => [a.id, a.name]));
    return notes.map(n => ({ id: n.id, content: n.content, authorId: n.authorId, authorName: names.get(n.authorId) ?? 'Autor indisponível', createdAt: n.createdAt, updatedAt: n.updatedAt }));
  }

  async notes(id: string, org: string, access: ChannelAccess) {
    await this.conversation(id, org, access);
    const notes = await this.prisma.internalNote.findMany({ where: { conversationId: id, conversation: { organizationId: org } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return this.withAuthors(notes, org);
  }

  async createNote(id: string, org: string, actorId: string, access: ChannelAccess, content: unknown) {
    await this.conversation(id, org, access);
    const text = this.content(content);
    const note = await this.prisma.$transaction(async tx => {
      const note = await tx.internalNote.create({ data: { conversationId: id, authorId: actorId, content: text } });
      await this.auditNote(tx, id, actorId, note.id, 'CREATED');
      return note;
    });
    return (await this.withAuthors([note], org))[0];
  }

  private async ownedNote(tx: Prisma.TransactionClient, id: string, org: string, noteId: string, actorId: string) {
    const note = await tx.internalNote.findFirst({ where: { id: noteId, conversationId: id, conversation: { organizationId: org } } });
    if (!note) throw new NotFoundException('Nota não encontrada');
    if (note.authorId !== actorId) throw new ForbiddenException('Somente o autor pode alterar ou apagar a nota');
    return note;
  }

  private auditNote(tx: Prisma.TransactionClient, id: string, actorId: string, noteId: string, action: string) {
    return tx.conversationAuditLog.create({ data: { conversationId: id, actorId, action: `INTERNAL_NOTE_${action}`, metadata: { noteId } } });
  }

  async updateNote(id: string, org: string, actorId: string, access: ChannelAccess, noteId: string, content: unknown) {
    await this.conversation(id, org, access);
    const text = this.content(content);
    const note = await this.prisma.$transaction(async tx => {
      await this.ownedNote(tx, id, org, noteId, actorId);
      const note = await tx.internalNote.update({ where: { id: noteId, conversationId: id, authorId: actorId }, data: { content: text } });
      await this.auditNote(tx, id, actorId, noteId, 'UPDATED');
      return note;
    });
    return (await this.withAuthors([note], org))[0];
  }

  async deleteNote(id: string, org: string, actorId: string, access: ChannelAccess, noteId: string) {
    await this.conversation(id, org, access);
    await this.prisma.$transaction(async tx => {
      await this.ownedNote(tx, id, org, noteId, actorId);
      await tx.internalNote.delete({ where: { id: noteId, conversationId: id, authorId: actorId } });
      await this.auditNote(tx, id, actorId, noteId, 'DELETED');
    });
    return { id: noteId };
  }

  private identity(type: string, contact: { phone: string | null; email: string | null }): string | null {
    if (type === 'GMAIL') return contact.email?.trim().toLowerCase() || null;
    const phone = contact.phone?.replace(/\D/g, '');
    if (!phone || phone.length < 7 || phone.length > 15) return null;
    if (type === 'WHATSAPP_ZAPPFY') return `${phone}@s.whatsapp.net`;
    if (type === 'WHATSAPP_OFFICIAL') return phone;
    return null;
  }

  private existing(org: string, channelId: string, contactId: string) {
    return findFirstNotMerged(({ skip, take }) => this.prisma.conversation.findMany({
      where: { organizationId: org, channelId, contactId, deletedAt: null, isGroup: false },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }], skip, take,
    }));
  }

  async sendChannels(id: string, org: string, access: ChannelAccess) {
    const conv = await this.conversation(id, org, access);
    const channels = await this.prisma.channel.findMany({
      where: { organizationId: org, deletedAt: null, ...(access === 'ALL' ? {} : { id: { in: [...access] } }), type: { in: ['WHATSAPP_ZAPPFY', 'WHATSAPP_OFFICIAL', 'GMAIL'] } },
      select: { id: true, name: true, type: true, isActive: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return Promise.all(channels.map(async channel => {
      const identity = this.identity(channel.type, conv.contact);
      const reason = conv.isGroup ? 'Não é possível trocar o canal de um grupo' : !channel.isActive ? 'Canal desativado' : !identity ? 'Contato sem identidade compatível neste canal' : null;
      const existing = conv.isGroup ? null : channel.id === conv.channelId ? conv : await this.existing(org, channel.id, conv.contactId);
      return { channelId: channel.id, name: channel.name, type: channel.type, current: channel.id === conv.channelId, conversationId: existing?.id ?? null, available: reason === null, reason };
    }));
  }

  async openChannel(id: string, org: string, actorId: string, access: ChannelAccess, channelId: string) {
    const conv = await this.conversation(id, org, access);
    this.channelAccess.assertChannelAccess(access, channelId);
    const option = (await this.sendChannels(id, org, access)).find(c => c.channelId === channelId);
    if (!option) throw new NotFoundException('Canal não encontrado');
    if (!option.available) throw new BadRequestException(option.reason!);
    // O mesmo lock usado pelo resolvedor inbound protege também o reuso de
    // arquivadas. Não há criação de conversa de grupo neste caminho.
    return this.locks.withLock(`conv:${channelId}:${conv.contactId}`, async () => {
      const existing = channelId === conv.channelId ? conv : await this.existing(org, channelId, conv.contactId);
      if (existing) return { conversationId: existing.id };
      const externalId = this.identity(option.type, conv.contact)!;
      // Criar aqui evita readquirir o mesmo lock no resolvedor. Segue o
      // estado inicial usado por ele; silêncio e IA mantêm seus defaults.
      const created = await this.prisma.$transaction(async tx => {
        const linked = await tx.contactChannel.findFirst({ where: { channelId, externalId, channel: { organizationId: org }, contact: { organizationId: org } } });
        if (linked && linked.contactId !== conv.contactId) throw new BadRequestException('Identidade já vinculada a outro contato');
        if (!linked) await tx.contactChannel.create({ data: { channelId, contactId: conv.contactId, externalId } });
        const created = await tx.conversation.create({ data: { organizationId: org, channelId, contactId: conv.contactId, isGroup: false, status: 'PENDING' } });
        await tx.conversationAuditLog.create({ data: { conversationId: created.id, actorId, action: 'CREATED', metadata: { trigger: 'send_channel', sourceConversationId: id } } });
        return created;
      });
      this.realtime.emitToChannel(channelId, 'conversation:updated', { conversation: created });
      return { conversationId: created.id };
    });
  }
}
