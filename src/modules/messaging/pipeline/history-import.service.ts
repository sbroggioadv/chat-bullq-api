import { Injectable, Logger, Optional } from '@nestjs/common';
import { InboundMediaMirrorService } from '../messages/inbound-media-mirror.service';
import {
  Channel,
  ChannelType,
  ConversationStatus,
  MessageContentType as PrismaContentType,
  MessageDirection,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { findFirstNotMerged, throwIfMergedExtra } from '../conversations/merged-conversation';
import {
  NormalizedHistoricalConversation,
  NormalizedHistoricalMessage,
} from '../../channel-hub/ports/types';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

export interface ConversationImportResult {
  conversationId: string;
  contactId: string;
  isNew: boolean;
}

export interface MessagesImportResult {
  imported: number;
  skipped: number;
}

// Entre várias candidatas, vence a de mensagem mais recente, com desempate fixo.
const MOST_RECENT_FIRST = [
  { lastMessageAt: { sort: 'desc' as const, nulls: 'last' as const } },
  { createdAt: 'desc' as const },
  { id: 'desc' as const },
];

// Busca por thread: no WhatsApp a arquivada é duplicada fundida e fica de
// fora. No Gmail a thread É a conversa — arquivada pelo usuário continua
// sendo a dona da thread (senão a reimportação duplicaria o histórico).
const THREAD_LOOKUP_SKIPS_ARCHIVED: ReadonlySet<ChannelType> = new Set([
  ChannelType.WHATSAPP_ZAPPFY,
  ChannelType.WHATSAPP_OFFICIAL,
]);

@Injectable()
export class HistoryImportService {
  private readonly logger = new Logger(HistoryImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
    // @Optional só para specs que constroem o serviço por posição; no
    // MessagingModule o provider está registrado e é sempre injetado.
    @Optional() private readonly mediaMirror?: InboundMediaMirrorService,
  ) {}

  async importConversation(
    channel: Channel,
    normalized: NormalizedHistoricalConversation,
  ): Promise<ConversationImportResult> {
    const contactId = await this.upsertContact(channel, normalized);

    // 1) Match by provider thread id when present (Gmail: one thread = one conversation).
    if (normalized.externalConversationId) {
      // Extra fundida (pela marca, mesmo desarquivada) nunca é escolhida.
      const byThread = await findFirstNotMerged(({ skip, take }) =>
        this.prisma.conversation.findMany({
          where: {
            organizationId: channel.organizationId,
            channelId: channel.id,
            ...(THREAD_LOOKUP_SKIPS_ARCHIVED.has(channel.type) ? { isArchived: false } : {}),
            metadata: {
              path: ['externalConversationId'],
              equals: normalized.externalConversationId,
            },
          },
          orderBy: MOST_RECENT_FIRST,
          skip,
          take,
        }),
      );
      if (byThread) {
        if (
          normalized.lastMessageAt &&
          (!byThread.lastMessageAt || normalized.lastMessageAt > byThread.lastMessageAt)
        ) {
          await this.prisma.conversation.update({
            where: { id: byThread.id },
            data: { lastMessageAt: normalized.lastMessageAt },
          });
        }
        return { conversationId: byThread.id, contactId, isNew: false };
      }
    }

    // Gmail threads must remain distinct; other channels reuse an open conversation.
    // Grupo não encerra: reutiliza a conversa mais recente do grupo em qualquer
    // status, arquivada ou não (nunca extra fundida), SEM desarquivar nem
    // reabrir aqui — isso só acontece em importMessages, se a sincronização
    // trouxer mensagem nova (reviveGroupOnNewMessages).
    const existing = channel.type === ChannelType.GMAIL && normalized.externalConversationId
      ? null
      : await findFirstNotMerged(({ skip, take }) =>
          this.prisma.conversation.findMany({
            where: {
              organizationId: channel.organizationId,
              channelId: channel.id,
              contactId,
              ...(normalized.isGroup
                ? {}
                : {
                    status: {
                      in: [
                        ConversationStatus.PENDING,
                        ConversationStatus.OPEN,
                        ConversationStatus.BOT,
                        ConversationStatus.WAITING,
                      ],
                    },
                    isArchived: false,
                  }),
            },
            orderBy: MOST_RECENT_FIRST,
            skip,
            take,
          }),
        );

    if (existing) {
      const data: Record<string, any> = {};
      if (normalized.isGroup && !existing.isGroup) data.isGroup = true;
      if (normalized.externalConversationId) {
        const metadata = existing.metadata;
        data.metadata = {
          ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
          externalConversationId: normalized.externalConversationId,
        };
      }
      if (normalized.lastMessageAt && (!existing.lastMessageAt || normalized.lastMessageAt > existing.lastMessageAt)) {
        data.lastMessageAt = normalized.lastMessageAt;
      }
      if (Object.keys(data).length) {
        await this.prisma.conversation.update({
          where: { id: existing.id },
          data,
        });
      }
      return { conversationId: existing.id, contactId, isNew: false };
    }

    const protocol = this.generateProtocol();
    const conversation = await this.prisma.conversation.create({
      data: {
        organizationId: channel.organizationId,
        channelId: channel.id,
        contactId,
        status:
          (normalized.unreadCount ?? 0) > 0
            ? ConversationStatus.PENDING
            : ConversationStatus.OPEN,
        protocol,
        isGroup: normalized.isGroup || false,
        lastMessageAt: normalized.lastMessageAt,
        metadata: {
          imported: true,
          externalConversationId: normalized.externalConversationId,
        },
      },
    });

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: conversation.id,
        action: 'CREATED',
        toValue: ConversationStatus.PENDING,
        metadata: { source: 'history_import' },
      },
    });

    return { conversationId: conversation.id, contactId, isNew: true };
  }

  async importMessages(
    channel: Channel,
    conversationId: string,
    messages: NormalizedHistoricalMessage[],
  ): Promise<MessagesImportResult> {
    if (messages.length === 0) return { imported: 0, skipped: 0 };

    // Antes de gravar cada página, leitura comum (sem lock): se a conversa
    // virou extra fundida pela limpeza de duplicadas, nada é gravado e
    // MergedConversationError sobe — a sincronização re-resolve a conversa.
    const { createdExternalIds, ...result } = await this.prisma.$transaction(async (tx) => {
      await throwIfMergedExtra(tx, conversationId);
      // Estado lido ANTES de gravar: a gravação de lastMessageAt muda updatedAt.
      const before = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { isGroup: true, isArchived: true, archivedAt: true, status: true, closedAt: true, updatedAt: true },
      });
      const { newestCreatedAt, ...inserted } = await this.insertMessages(tx, conversationId, messages);
      await this.reviveGroupOnNewMessages(tx, conversationId, before, newestCreatedAt);
      return inserted;
    });

    // SPEC-017: depois do commit, dispara o espelhamento da mídia do CDN da
    // Meta das mensagens recém-criadas SEM esperar: Redis lento ou fora do ar
    // não pode atrasar nem travar a importação. enqueueImported já loga e
    // devolve 0 em falha; o catch só impede uma rejeição solta.
    if (channel.type === ChannelType.INSTAGRAM && createdExternalIds.length) {
      this.mediaMirror
        ?.enqueueImported(channel.id, conversationId, createdExternalIds)
        .catch(() => undefined);
    }
    return result;
  }

  private async insertMessages(
    tx: Prisma.TransactionClient,
    conversationId: string,
    messages: NormalizedHistoricalMessage[],
  ): Promise<MessagesImportResult & { createdExternalIds: string[]; newestCreatedAt: Date | null }> {
    const externalIds = messages.map((m) => m.externalMessageId).filter(Boolean);
    const existing = await tx.message.findMany({
      where: {
        conversationId,
        externalId: { in: externalIds },
      },
      select: { externalId: true },
    });
    const existingSet = new Set(existing.map((e) => e.externalId));

    const toCreate = messages.filter(
      (m) => m.externalMessageId && !existingSet.has(m.externalMessageId),
    );

    if (toCreate.length === 0) {
      return { imported: 0, skipped: messages.length, createdExternalIds: [], newestCreatedAt: null };
    }

    await tx.message.createMany({
      data: toCreate.map((m) => ({
        conversationId,
        direction: m.direction,
        type: m.type as unknown as PrismaContentType,
        content: m.content as any,
        externalId: m.externalMessageId,
        status:
          m.direction === MessageDirection.OUTBOUND
            ? MessageStatus.SENT
            : MessageStatus.DELIVERED,
        senderName: m.senderName ?? null,
        sentAt: m.direction === MessageDirection.OUTBOUND ? m.timestamp : null,
        deliveredAt: m.direction === MessageDirection.INBOUND ? m.timestamp : null,
        createdAt: m.timestamp,
        metadata: {
          imported: true,
          rawPayload: m.rawPayload ? JSON.parse(JSON.stringify(m.rawPayload)) : null,
        },
      })),
      skipDuplicates: true,
    });

    const latestTimestamp = toCreate.reduce(
      (max, m) => (m.timestamp > max ? m.timestamp : max),
      new Date(0),
    );
    if (latestTimestamp.getTime() > 0) {
      await tx.conversation.updateMany({
        where: { id: conversationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: latestTimestamp } }] },
        data: { lastMessageAt: latestTimestamp },
      });
    }

    return {
      imported: toCreate.length,
      skipped: messages.length - toCreate.length,
      createdExternalIds: toCreate.map((m) => m.externalMessageId),
      newestCreatedAt: latestTimestamp.getTime() > 0 ? latestTimestamp : null,
    };
  }

  // Grupo não encerra: a conversa arquivada (ou fechada) do grupo só volta à
  // caixa se a sincronização trouxe mensagem NOVA — ainda não gravada
  // (insertMessages) e posterior ao arquivamento/fechamento (sem a data,
  // updatedAt lido antes da gravação). Sincronização sem mensagem nova não
  // desarquiva nem reabre nada. Pessoa: nada muda aqui.
  private async reviveGroupOnNewMessages(
    tx: Prisma.TransactionClient,
    conversationId: string,
    before: {
      isGroup: boolean;
      isArchived: boolean;
      archivedAt: Date | null;
      status: ConversationStatus;
      closedAt: Date | null;
      updatedAt: Date;
    } | null,
    newestCreatedAt: Date | null,
  ): Promise<void> {
    if (!before?.isGroup || !newestCreatedAt) return;
    const unarchive = before.isArchived && newestCreatedAt > (before.archivedAt ?? before.updatedAt);
    const reopen = before.status === ConversationStatus.CLOSED
      && newestCreatedAt > (before.closedAt ?? before.updatedAt);
    if (!unarchive && !reopen) return;

    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        ...(unarchive ? { isArchived: false, archivedAt: null, archivedById: null } : {}),
        ...(reopen ? { status: ConversationStatus.PENDING, closedAt: null, assignedToId: null } : {}),
      },
    });
    const metadata = { trigger: 'history_import_new_message', isGroup: true };
    if (unarchive) {
      await tx.conversationAuditLog.create({ data: { conversationId, action: 'UNARCHIVED', metadata } });
    }
    if (reopen) {
      await tx.conversationAuditLog.create({
        data: {
          conversationId,
          action: 'REOPENED',
          fromValue: ConversationStatus.CLOSED,
          toValue: ConversationStatus.PENDING,
          metadata,
        },
      });
    }
  }

  async notifyConversationImported(
    organizationId: string,
    conversationId: string,
  ): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channelId: true },
    });
    if (!conv) return;
    this.realtimeGateway.emitToChannel(conv.channelId, 'conversation:imported', {
      conversationId,
    });
  }

  private async upsertContact(
    channel: Channel,
    normalized: NormalizedHistoricalConversation,
  ): Promise<string> {
    const existing = await this.prisma.contactChannel.findUnique({
      where: {
        uq_contact_channel_external: {
          channelId: channel.id,
          externalId: normalized.externalContactId,
        },
      },
      include: { contact: true },
    });

    if (existing) {
      if (existing.contact.organizationId !== channel.organizationId) {
        throw new Error('cross_org_contact_channel');
      }
      const updates: Record<string, any> = {};
      if (normalized.contactName && normalized.contactName !== existing.profileName) {
        updates.profileName = normalized.contactName;
      }
      if (
        normalized.contactAvatarUrl &&
        normalized.contactAvatarUrl !== existing.profileAvatarUrl
      ) {
        updates.profileAvatarUrl = normalized.contactAvatarUrl;
      }
      if (Object.keys(updates).length > 0) {
        await this.prisma.contactChannel.update({
          where: { id: existing.id },
          data: updates,
        });
      }
      return existing.contactId;
    }

    const looksLikeEmail = /@/.test(normalized.externalContactId || '');
    const contact = await this.prisma.contact.create({
      data: {
        organizationId: channel.organizationId,
        name: normalized.contactName,
        phone: normalized.contactPhone,
        email: looksLikeEmail ? normalized.externalContactId.toLowerCase() : undefined,
        avatarUrl: normalized.contactAvatarUrl,
        channels: {
          create: {
            channelId: channel.id,
            externalId: normalized.externalContactId,
            profileName: normalized.contactName,
            profileAvatarUrl: normalized.contactAvatarUrl,
          },
        },
      },
    });

    return contact.id;
  }

  private generateProtocol(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${date}-${rand}`;
  }
}
