import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChannelAccess, ChannelAccessService } from '../iam/channel-access/channel-access.service';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService, private readonly channelAccess: ChannelAccessService) {}

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
    });

    const { password: _, ...sanitized } = user;
    return sanitized;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const isValid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    this.logger.log(`Password changed for user ${userId}`);
  }

  async getPreferences(userId: string, organizationId: string) {
    const membership = await this.prisma.userOrganization.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { preferences: true },
    });

    if (!membership) {
      throw new NotFoundException('Membership not found');
    }

    return (membership.preferences ?? {}) as Record<string, unknown>;
  }

  async updatePreferences(
    userId: string,
    organizationId: string,
    patch: Record<string, unknown>,
  ) {
    const { pinnedConversations: _ignored, ...safePatch } = patch;
    const rows = await this.prisma.$queryRaw<{ preferences: Prisma.JsonValue }[]>`
      UPDATE user_organizations SET preferences = COALESCE(preferences, '{}'::jsonb) || ${JSON.stringify(safePatch)}::jsonb
      WHERE user_id = ${userId} AND organization_id = ${organizationId}
      RETURNING preferences`;
    if (!rows.length) throw new NotFoundException('Membership not found');
    return rows[0].preferences;
  }

  async setPinned(userId: string, organizationId: string, id: string, pin: boolean, access: ChannelAccess) {
    if (pin) {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id, organizationId, deletedAt: null, channel: { deletedAt: null } },
        select: { channelId: true },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
      this.channelAccess.assertChannelAccess(access, conversation.channelId);
    }
    const item = JSON.stringify({ id, pinnedAt: new Date().toISOString() });
    // Compute visibility from the row being updated, so concurrent pins are
    // serialized by PostgreSQL and no previously visible pin is overwritten.
    const channels = JSON.stringify(access === 'ALL' ? [] : [...access]);
    const visiblePins = Prisma.sql`COALESCE((SELECT jsonb_agg(entry ORDER BY ordinal)
      FROM jsonb_array_elements(COALESCE(preferences->'pinnedConversations', '[]'::jsonb)) WITH ORDINALITY AS pins(entry, ordinal)
      WHERE EXISTS (SELECT 1 FROM conversations c JOIN channels ch ON ch.id = c.channel_id
        WHERE c.id = entry->>'id' AND c.organization_id = ${organizationId}
          AND c.deleted_at IS NULL AND ch.deleted_at IS NULL
          AND (${access === 'ALL'}::boolean OR ${channels}::jsonb ? c.channel_id))), '[]'::jsonb)`;
    const rows = await this.prisma.$queryRaw<{ pinned: Prisma.JsonValue }[]>`
      UPDATE user_organizations SET preferences = jsonb_set(
        COALESCE(preferences, '{}'::jsonb), '{pinnedConversations}',
        CASE WHEN ${pin} THEN
          CASE WHEN ${visiblePins} @> jsonb_build_array(jsonb_build_object('id', ${id}::text))
            THEN ${visiblePins}
            ELSE ${visiblePins} || jsonb_build_array(${item}::jsonb) END
        ELSE COALESCE((SELECT jsonb_agg(entry) FROM jsonb_array_elements(COALESCE(preferences->'pinnedConversations', '[]'::jsonb)) entry WHERE entry->>'id' <> ${id}), '[]'::jsonb) END, true)
      WHERE user_id = ${userId} AND organization_id = ${organizationId}
        AND (NOT ${pin} OR jsonb_array_length(${visiblePins}) < 20
          OR ${visiblePins} @> jsonb_build_array(jsonb_build_object('id', ${id}::text)))
      RETURNING preferences->'pinnedConversations' AS pinned`;
    if (!rows.length) {
      await this.getPreferences(userId, organizationId);
      throw new BadRequestException('pin_limit_reached');
    }
    return rows[0].pinned;
  }
}
