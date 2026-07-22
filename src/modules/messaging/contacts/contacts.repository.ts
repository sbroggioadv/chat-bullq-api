import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class ContactsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByOrg(
    organizationId: string,
    search: string | undefined,
    skip: number,
    take: number,
    opts?: { shareableOnly?: boolean },
  ) {
    const where: Prisma.ContactWhereInput = { organizationId, deletedAt: null };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
        // WhatsApp pushName stored on contact-channel
        {
          channels: {
            some: {
              profileName: { contains: search, mode: 'insensitive' },
            },
          },
        },
      ];
    }

    // Share picker: only contacts with a real phone (digits), not WhatsApp @lid
    // IDs. LID contacts look like "243864048775323@lid" and are useless to share.
    if (opts?.shareableOnly) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { phone: { not: null } },
        { NOT: { phone: { contains: '@' } } },
        { NOT: { phone: { contains: 'lid' } } },
        // At least 8 digits in phone field (E.164 without symbols still ok)
        { phone: { not: '' } },
      ];
    }

    const [contacts, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        include: {
          channels: {
            include: {
              channel: { select: { id: true, type: true, name: true } },
            },
          },
          tags: { include: { tag: true } },
          _count: { select: { conversations: true } },
        },
        // Prefer named contacts first for the share picker
        orderBy: opts?.shareableOnly
          ? [{ name: 'asc' }, { updatedAt: 'desc' }]
          : { updatedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.contact.count({ where }),
    ]);

    return { contacts, total };
  }

  async findById(id: string) {
    return this.prisma.contact.findFirst({
      where: { id, deletedAt: null },
      include: {
        channels: { include: { channel: { select: { id: true, type: true, name: true } } } },
        tags: { include: { tag: true } },
        conversations: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            channel: { select: { type: true, name: true } },
            messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, type: true, createdAt: true } },
          },
        },
      },
    });
  }

  async update(id: string, data: Prisma.ContactUpdateInput) {
    return this.prisma.contact.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    return this.prisma.contact.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
