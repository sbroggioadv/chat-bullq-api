import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class QuickRepliesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.QuickReplyCreateInput) {
    return this.prisma.quickReply.create({ data });
  }

  async findByOrgAndUser(organizationId: string, userId: string) {
    return this.prisma.quickReply.findMany({
      where: {
        organizationId,
        deletedAt: null,
        OR: [{ userId }, { userId: null }],
      },
      orderBy: { shortcut: 'asc' },
    });
  }

  async findById(id: string) {
    return this.prisma.quickReply.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findByShortcut(
    organizationId: string,
    userId: string | null,
    shortcut: string,
  ) {
    return this.prisma.quickReply.findFirst({
      where: { organizationId, userId, shortcut, deletedAt: null },
    });
  }

  async update(id: string, data: Prisma.QuickReplyUpdateInput) {
    return this.prisma.quickReply.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    return this.prisma.quickReply.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
