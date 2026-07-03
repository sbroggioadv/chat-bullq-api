import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class MessagesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.MessageUncheckedCreateInput) {
    return this.prisma.message.create({
      data,
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async findByConversation(
    conversationId: string,
    skip: number,
    take: number,
    includeTotal = true,
  ) {
    if (includeTotal) {
      const [messages, total] = await this.prisma.$transaction([
        this.prisma.message.findMany({
          where: { conversationId },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
          include: {
            sender: { select: { id: true, name: true, avatarUrl: true } },
          },
        }),
        this.prisma.message.count({ where: { conversationId } }),
      ]);
      return {
        messages: messages.reverse(),
        total,
        hasMore: skip + messages.length < total,
      };
    }

    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: take + 1,
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    const messages = rows.slice(0, take);
    return {
      messages: messages.reverse(),
      total: null,
      hasMore: rows.length > take,
    };
  }

  /**
   * Timeline UNIFICADA de um grupo de segmento: une as mensagens de várias
   * conversas-irmãs, deduplicando pelo external_id e ordenando pelo tempo do
   * provedor (fallback created_at). O caminho rápido evita COUNT DISTINCT.
   */
  async findByConversationsUnioned(
    conversationIds: string[],
    skip: number,
    take: number,
    includeTotal = true,
  ) {
    const ids = Prisma.join(conversationIds);

    const pageRows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(external_id, id)
                 ORDER BY COALESCE(provider_timestamp, created_at) ASC
               ) AS rn
        FROM messages
        WHERE conversation_id IN (${ids})
      )
      SELECT r.id
      FROM ranked r
      JOIN messages m ON m.id = r.id
      WHERE r.rn = 1
      ORDER BY COALESCE(m.provider_timestamp, m.created_at) DESC
      LIMIT ${take + 1} OFFSET ${skip}
    `;

    const pageIds = pageRows.slice(0, take).map((r) => r.id);
    const total = includeTotal
      ? Number(
          (
            await this.prisma.$queryRaw<{ count: bigint }[]>`
              SELECT COUNT(*)::bigint AS count FROM (
                SELECT DISTINCT COALESCE(external_id, id) AS k
                FROM messages
                WHERE conversation_id IN (${ids})
              ) t
            `
          )[0]?.count ?? 0,
        )
      : null;

    if (pageIds.length === 0) {
      return { messages: [], total, hasMore: false };
    }

    const rows = await this.prisma.message.findMany({
      where: { id: { in: pageIds } },
      include: { sender: { select: { id: true, name: true, avatarUrl: true } } },
    });
    const byId = new Map(rows.map((m) => [m.id, m]));
    const ordered = pageIds.map((id) => byId.get(id)!).filter(Boolean);
    return {
      messages: ordered.reverse(),
      total,
      hasMore: includeTotal ? skip + pageIds.length < (total ?? 0) : pageRows.length > take,
    };
  }

  async findById(id: string) {
    return this.prisma.message.findUnique({ where: { id } });
  }

  async updateStatus(id: string, data: Prisma.MessageUpdateInput) {
    return this.prisma.message.update({ where: { id }, data });
  }
}
