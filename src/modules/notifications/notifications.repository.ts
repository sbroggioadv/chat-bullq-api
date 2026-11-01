import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, NotificationType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.NotificationUncheckedCreateInput) {
    return this.prisma.notification.create({ data });
  }

  async findByUser(userId: string, orgId: string, skip: number, take: number) {
    const [notifications, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where: { recipientId: userId, organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.notification.count({
        where: { recipientId: userId, organizationId: orgId },
      }),
    ]);
    return { notifications, total };
  }

  async countUnread(userId: string, orgId: string) {
    return this.prisma.notification.count({
      where: { recipientId: userId, organizationId: orgId, isRead: false },
    });
  }

  async markRead(id: string, userId: string, orgId: string) {
    try {
      return await this.prisma.notification.update({
        where: { id, recipientId: userId, organizationId: orgId },
        data: { isRead: true, readAt: new Date() },
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
        throw new NotFoundException('Notification not found');
      }
      throw error;
    }
  }

  async markAllRead(userId: string, orgId: string) {
    return this.prisma.notification.updateMany({
      where: { recipientId: userId, organizationId: orgId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  }
}
