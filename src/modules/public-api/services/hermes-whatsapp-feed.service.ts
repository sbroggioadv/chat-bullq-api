import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ChannelType,
  MessageContentType,
  MessageDirection,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import type { ChannelAccess } from '../../iam/channel-access/channel-access.service';
import type { HermesWhatsappFeedQueryDto } from '../dto/hermes-whatsapp-feed-query.dto';

const FEED_SCHEMA = 'bullq.hermes.whatsapp-feed.v1' as const;
const MAX_LIMIT = 200;
const WHATSAPP_CHANNEL_TYPES = [
  ChannelType.WHATSAPP_ZAPPFY,
  ChannelType.WHATSAPP_OFFICIAL,
];

interface FeedCursor {
  ingestedAt: Date;
  id: string;
}

interface EncodedFeedCursor {
  ingestedAt: string;
  id: string;
}

interface ProjectedContactChannel {
  channelId: string;
  externalId: string;
  profileName: string | null;
}

interface ProjectedMessage {
  id: string;
  externalId: string | null;
  direction: MessageDirection;
  type: MessageContentType;
  content: Prisma.JsonValue;
  senderName: string | null;
  senderId: string | null;
  providerTimestamp: Date | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  ingestedAt: Date;
  sender: { name: string } | null;
  conversation: {
    id: string;
    channelId: string;
    isGroup: boolean;
    subject: string | null;
    contact: {
      name: string | null;
      channels: ProjectedContactChannel[];
    };
  };
}

export interface HermesWhatsappFeedMessage {
  id: string;
  external_message_id: string | null;
  conversation_id: string;
  channel_id: string;
  chat_id: string | null;
  conversation_name: string;
  is_group: boolean;
  direction: MessageDirection;
  sender_name: string | null;
  sender_user_id: string | null;
  sender_user_name: string | null;
  type: MessageContentType;
  text: string | null;
  provider_timestamp: string;
  ingested_at: string;
}

export interface HermesWhatsappFeedResponse {
  schema: typeof FEED_SCHEMA;
  generated_at: string;
  next_cursor: string | null;
  has_more: boolean;
  messages: HermesWhatsappFeedMessage[];
}

export interface HermesWhatsappFeedQuery
  extends Pick<HermesWhatsappFeedQueryDto, 'cursor' | 'limit'> {
  directions?: MessageDirection[];
}

@Injectable()
export class HermesWhatsappFeedService {
  constructor(private readonly prisma: PrismaService) {}

  async getFeed(
    organizationId: string,
    access: ChannelAccess,
    query: HermesWhatsappFeedQuery,
  ): Promise<HermesWhatsappFeedResponse> {
    const limit = query.limit ?? 100;
    this.assertValidLimit(limit);
    const cursor = query.cursor ? HermesWhatsappFeedService.decodeCursor(query.cursor) : null;

    if (access !== 'ALL' && access.size === 0) {
      return this.emptyResponse(query.cursor ?? null);
    }

    const cursorWhere: Prisma.MessageWhereInput = cursor
      ? {
          OR: [
            { ingestedAt: { gt: cursor.ingestedAt } },
            { ingestedAt: cursor.ingestedAt, id: { gt: cursor.id } },
          ],
        }
      : {};

    const rows: ProjectedMessage[] = await this.prisma.message.findMany({
      where: {
        ...cursorWhere,
        revokedAt: null,
        ...(query.directions?.length
          ? { direction: { in: query.directions } }
          : {}),
        ...this.messageScope(organizationId, access),
      },
      orderBy: [{ ingestedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        externalId: true,
        direction: true,
        type: true,
        content: true,
        senderName: true,
        senderId: true,
        providerTimestamp: true,
        sentAt: true,
        deliveredAt: true,
        createdAt: true,
        ingestedAt: true,
        sender: { select: { name: true } },
        conversation: {
          select: {
            id: true,
            channelId: true,
            isGroup: true,
            subject: true,
            contact: {
              select: {
                name: true,
                channels: {
                  select: {
                    channelId: true,
                    externalId: true,
                    profileName: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      schema: FEED_SCHEMA,
      generated_at: new Date().toISOString(),
      next_cursor: last
        ? HermesWhatsappFeedService.encodeCursor({
            ingestedAt: last.ingestedAt,
            id: last.id,
          })
        : (query.cursor ?? null),
      has_more: hasMore,
      messages: page.map((row) => this.toFeedMessage(row)),
    };
  }

  async getConversation(
    organizationId: string,
    access: ChannelAccess,
    conversationId: string,
    messageLimit: number,
  ) {
    if (!Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 50) {
      throw new BadRequestException('message_limit must be an integer between 1 and 50');
    }
    if (access !== 'ALL' && access.size === 0) return null;

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        ...this.conversationScope(organizationId, access),
      },
      select: {
        id: true,
        channelId: true,
        subject: true,
        isGroup: true,
        contact: {
          select: {
            name: true,
            channels: {
              select: { channelId: true, externalId: true, profileName: true },
            },
          },
        },
        messages: {
          where: { revokedAt: null },
          orderBy: [{ ingestedAt: 'desc' }, { id: 'desc' }],
          take: messageLimit,
          select: {
            id: true,
            externalId: true,
            direction: true,
            type: true,
            content: true,
            senderName: true,
            senderId: true,
            providerTimestamp: true,
            sentAt: true,
            deliveredAt: true,
            createdAt: true,
            ingestedAt: true,
            sender: { select: { name: true } },
          },
        },
      },
    });

    if (!conversation) return null;
    const contactChannel = conversation.contact.channels.find(
      (candidate) => candidate.channelId === conversation.channelId,
    );
    const conversationName = this.firstNonBlank(
      conversation.subject,
      conversation.contact.name,
      contactChannel?.profileName,
    );

    return {
      schema: 'bullq.hermes.whatsapp-conversation.v1' as const,
      generated_at: new Date().toISOString(),
      conversation: {
        id: conversation.id,
        channel_id: conversation.channelId,
        chat_id: contactChannel?.externalId ?? null,
        name: conversationName ?? 'Conversa sem nome',
        is_group: conversation.isGroup,
      },
      messages: [...conversation.messages].reverse().map((message) => {
        const providerTimestamp =
          message.providerTimestamp ??
          message.sentAt ??
          message.deliveredAt ??
          message.createdAt;
        return {
          id: message.id,
          external_message_id: message.externalId,
          direction: message.direction,
          sender_name: message.senderName ?? message.sender?.name ?? null,
          sender_user_id: message.senderId,
          sender_user_name: message.sender?.name ?? null,
          type: message.type,
          text: this.extractText(message.content),
          provider_timestamp: providerTimestamp.toISOString(),
          ingested_at: message.ingestedAt.toISOString(),
        };
      }),
    };
  }

  async getHealth(organizationId: string, access: ChannelAccess) {
    const generatedAt = new Date();
    if (access !== 'ALL' && access.size === 0) {
      return {
        schema: 'bullq.hermes.whatsapp-feed-health.v1' as const,
        generated_at: generatedAt.toISOString(),
        total_messages: 0,
        inbound_messages: 0,
        outbound_messages: 0,
        latest_ingested_at: null,
        freshness_seconds: null,
      };
    }

    const where = {
      revokedAt: null,
      ...this.messageScope(organizationId, access),
    } satisfies Prisma.MessageWhereInput;
    const [counts, latest] = await Promise.all([
      this.prisma.message.groupBy({
        by: ['direction'],
        where,
        _count: { _all: true },
      }),
      this.prisma.message.findFirst({
        where,
        orderBy: [{ ingestedAt: 'desc' }, { id: 'desc' }],
        select: { ingestedAt: true },
      }),
    ]);
    const inbound = counts.find(
      (row) => row.direction === MessageDirection.INBOUND,
    )?._count._all ?? 0;
    const outbound = counts.find(
      (row) => row.direction === MessageDirection.OUTBOUND,
    )?._count._all ?? 0;

    return {
      schema: 'bullq.hermes.whatsapp-feed-health.v1' as const,
      generated_at: generatedAt.toISOString(),
      total_messages: inbound + outbound,
      inbound_messages: inbound,
      outbound_messages: outbound,
      latest_ingested_at: latest?.ingestedAt.toISOString() ?? null,
      freshness_seconds: latest
        ? Math.max(0, Math.floor((generatedAt.getTime() - latest.ingestedAt.getTime()) / 1000))
        : null,
    };
  }

  static encodeCursor(cursor: FeedCursor): string {
    const payload: EncodedFeedCursor = {
      ingestedAt: cursor.ingestedAt.toISOString(),
      id: cursor.id,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  static decodeCursor(cursor: string): FeedCursor {
    if (
      cursor.length === 0 ||
      cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    ) {
      throw new BadRequestException('Invalid cursor');
    }

    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const payload: unknown = JSON.parse(decoded);
      if (!HermesWhatsappFeedService.isEncodedCursor(payload)) {
        throw new Error('Malformed cursor payload');
      }
      const ingestedAt = new Date(payload.ingestedAt);
      if (
        Number.isNaN(ingestedAt.getTime()) ||
        ingestedAt.toISOString() !== payload.ingestedAt
      ) {
        throw new Error('Invalid cursor timestamp');
      }
      return { ingestedAt, id: payload.id };
    } catch {
      throw new BadRequestException('Invalid cursor');
    }
  }

  private static isEncodedCursor(value: unknown): value is EncodedFeedCursor {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.ingestedAt === 'string' &&
      typeof candidate.id === 'string' &&
      candidate.id.length > 0 &&
      candidate.id.length <= 256
    );
  }

  private assertValidLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
  }

  private conversationScope(
    organizationId: string,
    access: ChannelAccess,
  ): Prisma.ConversationWhereInput {
    return {
      organizationId,
      deletedAt: null,
      ...(access === 'ALL' ? {} : { channelId: { in: [...access] } }),
      channel: {
        type: { in: WHATSAPP_CHANNEL_TYPES },
        deletedAt: null,
      },
    };
  }

  private messageScope(
    organizationId: string,
    access: ChannelAccess,
  ): Prisma.MessageWhereInput {
    return { conversation: this.conversationScope(organizationId, access) };
  }

  private emptyResponse(cursor: string | null): HermesWhatsappFeedResponse {
    return {
      schema: FEED_SCHEMA,
      generated_at: new Date().toISOString(),
      next_cursor: cursor,
      has_more: false,
      messages: [],
    };
  }

  private toFeedMessage(row: ProjectedMessage): HermesWhatsappFeedMessage {
    const contactChannel = row.conversation.contact.channels.find(
      (candidate) => candidate.channelId === row.conversation.channelId,
    );
    const conversationName = this.firstNonBlank(
      row.conversation.subject,
      row.conversation.contact.name,
      contactChannel?.profileName,
    );
    const providerTimestamp =
      row.providerTimestamp ?? row.sentAt ?? row.deliveredAt ?? row.createdAt;

    return {
      id: row.id,
      external_message_id: row.externalId,
      conversation_id: row.conversation.id,
      channel_id: row.conversation.channelId,
      chat_id: contactChannel?.externalId ?? null,
      conversation_name: conversationName ?? 'Conversa sem nome',
      is_group: row.conversation.isGroup,
      direction: row.direction,
      sender_name: row.senderName ?? row.sender?.name ?? null,
      sender_user_id: row.senderId,
      sender_user_name: row.sender?.name ?? null,
      type: row.type,
      text: this.extractText(row.content),
      provider_timestamp: providerTimestamp.toISOString(),
      ingested_at: row.ingestedAt.toISOString(),
    };
  }

  private extractText(content: Prisma.JsonValue): string | null {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
    const record = content as Prisma.JsonObject;
    return this.firstNonBlank(
      typeof record.text === 'string' ? record.text : null,
      typeof record.caption === 'string' ? record.caption : null,
    );
  }

  private firstNonBlank(...values: Array<string | null | undefined>): string | null {
    for (const value of values) {
      const normalized = value?.trim();
      if (normalized) return normalized;
    }
    return null;
  }
}
