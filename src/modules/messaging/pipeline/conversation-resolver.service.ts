import { Injectable, Logger } from '@nestjs/common';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { IdempotencyService } from './idempotency.service';
import { findFirstNotMerged } from '../conversations/merged-conversation';

export interface ResolvedConversation {
  conversationId: string;
  status: ConversationStatus;
  isNew: boolean;
  wasReopened: boolean;
}

const OPEN_STATES = [
  ConversationStatus.PENDING,
  ConversationStatus.OPEN,
  ConversationStatus.BOT,
  ConversationStatus.WAITING,
] as const;

// Conversa arquivada nunca recebe mensagem nova: fica fora da escolha. Entre
// várias abertas, vence a de mensagem mais recente, com desempate fixo.
const MOST_RECENT_FIRST = [
  { lastMessageAt: { sort: 'desc' as const, nulls: 'last' as const } },
  { createdAt: 'desc' as const },
  { id: 'desc' as const },
];

@Injectable()
export class ConversationResolverService {
  private readonly logger = new Logger(ConversationResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async resolve(
    organizationId: string,
    channelId: string,
    contactId: string,
    isGroup?: boolean,
  ): Promise<ResolvedConversation> {
    // Fast path without lock — most webhooks hit an already-open conversation.
    const fast = await this.findOpen(organizationId, channelId, contactId);
    if (fast) return this.touchOpen(fast, isGroup);

    // Need to create or reopen — serialise to prevent duplicate conversations.
    return this.idempotency.withLock(
      `conv:${channelId}:${contactId}`,
      async () => {
        const existing = await this.findOpen(organizationId, channelId, contactId);
        if (existing) return this.touchOpen(existing, isGroup);

        // Extra fundida (pela marca, mesmo desarquivada) nunca é reaberta.
        // Paginação estável: desempate por id depois de closedAt.
        const lastClosed = await findFirstNotMerged(({ skip, take }) =>
          this.prisma.conversation.findMany({
            where: {
              organizationId,
              channelId,
              contactId,
              status: ConversationStatus.CLOSED,
              isArchived: false,
            },
            orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
            skip,
            take,
          }),
        );

        if (lastClosed) {
          const closedAt = lastClosed.closedAt || lastClosed.updatedAt;
          const hoursSinceClosed = (Date.now() - closedAt.getTime()) / (1000 * 60 * 60);
          if (hoursSinceClosed < 24) {
            await this.prisma.conversation.update({
              where: { id: lastClosed.id },
              data: {
                status: ConversationStatus.PENDING,
                closedAt: null,
                assignedToId: null,
              },
            });
            await this.prisma.conversationAuditLog.create({
              data: {
                conversationId: lastClosed.id,
                action: 'REOPENED',
                fromValue: ConversationStatus.CLOSED,
                toValue: ConversationStatus.PENDING,
                metadata: { trigger: 'new_inbound_message' },
              },
            });
            this.logger.log(`Conversation reopened: ${lastClosed.id}`);
            return {
              conversationId: lastClosed.id,
              status: ConversationStatus.PENDING,
              isNew: false,
              wasReopened: true,
            };
          }
        }

        const protocol = this.generateProtocol();
        const conversation = await this.prisma.conversation.create({
          data: {
            organizationId,
            channelId,
            contactId,
            status: ConversationStatus.PENDING,
            protocol,
            isGroup: isGroup || false,
          },
        });
        await this.prisma.conversationAuditLog.create({
          data: {
            conversationId: conversation.id,
            action: 'CREATED',
            toValue: ConversationStatus.PENDING,
          },
        });
        this.logger.log(
          `New conversation created: ${conversation.id} (protocol: ${protocol})`,
        );
        return {
          conversationId: conversation.id,
          status: ConversationStatus.PENDING,
          isNew: true,
          wasReopened: false,
        };
      },
    );
  }

  private async findOpen(
    organizationId: string,
    channelId: string,
    contactId: string,
  ) {
    // Extra fundida (pela marca, mesmo desarquivada) nunca é escolhida.
    return findFirstNotMerged(({ skip, take }) =>
      this.prisma.conversation.findMany({
        where: {
          organizationId,
          channelId,
          contactId,
          status: { in: Array.from(OPEN_STATES) },
          isArchived: false,
        },
        orderBy: MOST_RECENT_FIRST,
        skip,
        take,
      }),
    );
  }

  private async touchOpen(
    openConversation: {
      id: string;
      status: ConversationStatus;
      isGroup: boolean;
    },
    isGroup?: boolean,
  ): Promise<ResolvedConversation> {
    if (isGroup && !openConversation.isGroup) {
      await this.prisma.conversation.update({
        where: { id: openConversation.id },
        data: { isGroup: true },
      });
    }

    if (openConversation.status === ConversationStatus.WAITING) {
      await this.prisma.conversation.update({
        where: { id: openConversation.id },
        data: { status: ConversationStatus.OPEN },
      });
      await this.prisma.conversationAuditLog.create({
        data: {
          conversationId: openConversation.id,
          action: 'STATUS_CHANGED',
          fromValue: ConversationStatus.WAITING,
          toValue: ConversationStatus.OPEN,
          metadata: { trigger: 'customer_replied' },
        },
      });
      return {
        conversationId: openConversation.id,
        status: ConversationStatus.OPEN,
        isNew: false,
        wasReopened: false,
      };
    }

    return {
      conversationId: openConversation.id,
      status: openConversation.status,
      isNew: false,
      wasReopened: false,
    };
  }

  private generateProtocol(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${date}-${rand}`;
  }
}
