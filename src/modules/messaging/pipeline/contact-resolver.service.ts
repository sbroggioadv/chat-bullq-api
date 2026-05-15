import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { NormalizedInboundMessage } from '../../channel-hub/ports/types';
import { IdempotencyService } from './idempotency.service';

export interface ResolvedContact {
  contactId: string;
  contactChannelId: string;
  isNew: boolean;
}

@Injectable()
export class ContactResolverService {
  private readonly logger = new Logger(ContactResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async resolve(
    organizationId: string,
    channelId: string,
    message: NormalizedInboundMessage,
  ): Promise<ResolvedContact> {
    // Fast path: already exists, just refresh mutable fields.
    const existing = await this.prisma.contactChannel.findUnique({
      where: {
        uq_contact_channel_external: {
          channelId,
          externalId: message.externalContactId,
        },
      },
      include: { contact: true },
    });

    if (existing) {
      await this.applyProfileUpdates(existing, message);
      return {
        contactId: existing.contactId,
        contactChannelId: existing.id,
        isNew: false,
      };
    }

    // Slow path: needs insert. Serialise per (channel, externalId) to avoid
    // race between concurrent webhooks for the same brand-new contact.
    return this.idempotency.withLock(
      `contact:${channelId}:${message.externalContactId}`,
      async () => {
        // Re-check inside the lock — another worker may have just created it.
        const racer = await this.prisma.contactChannel.findUnique({
          where: {
            uq_contact_channel_external: {
              channelId,
              externalId: message.externalContactId,
            },
          },
          include: { contact: true },
        });
        if (racer) {
          await this.applyProfileUpdates(racer, message);
          return {
            contactId: racer.contactId,
            contactChannelId: racer.id,
            isNew: false,
          };
        }

        const contact = await this.prisma.contact.create({
          data: {
            organizationId,
            name: message.contactName,
            phone: message.contactPhone,
            avatarUrl: message.contactAvatarUrl,
            channels: {
              create: {
                channelId,
                externalId: message.externalContactId,
                profileName: message.contactName,
                profileAvatarUrl: message.contactAvatarUrl,
              },
            },
          },
          include: { channels: true },
        });

        this.logger.log(
          `New contact created: ${contact.id} (${message.contactPhone || message.externalContactId})`,
        );

        return {
          contactId: contact.id,
          contactChannelId: contact.channels[0].id,
          isNew: true,
        };
      },
    );
  }

  private async applyProfileUpdates(
    existing: {
      id: string;
      profileName: string | null;
      profileAvatarUrl: string | null;
      contactId: string;
      contact: {
        name: string | null;
        phone: string | null;
        metadata?: unknown;
      };
    },
    message: NormalizedInboundMessage,
  ): Promise<void> {
    const ccUpdates: Record<string, any> = {};
    if (message.contactName && message.contactName !== existing.profileName) {
      ccUpdates.profileName = message.contactName;
    }
    if (
      message.contactAvatarUrl &&
      message.contactAvatarUrl !== existing.profileAvatarUrl
    ) {
      ccUpdates.profileAvatarUrl = message.contactAvatarUrl;
    }
    if (Object.keys(ccUpdates).length > 0) {
      await this.prisma.contactChannel.update({
        where: { id: existing.id },
        data: ccUpdates,
      });
    }

    // contact.name is the user-visible label across the inbox. Updating it
    // is more sensitive than profileName (which is just the per-channel
    // raw value):
    //
    //   1) If the operator manually renamed the contact via the rename
    //      dialog, we MUST NOT overwrite — that's the whole point of
    //      renaming. We track this via `contact.metadata.nameLockedByUser`.
    //
    //   2) Otherwise, we *should* overwrite a stored name when the new one
    //      is authoritative (came from the contact's own profile, not an
    //      echo) AND it actually differs. This is what fixes the historical
    //      "operator's address-book label leaks into our contact name" bug.
    //
    //   3) If the name has never been set, fill it from whatever we got
    //      (including non-authoritative, which is better than nothing).
    const metadata =
      (existing.contact.metadata as Record<string, any> | null | undefined) ?? {};
    const isLocked = metadata.nameLockedByUser === true;
    const contactUpdates: Record<string, any> = {};

    if (message.contactName) {
      const currentName = existing.contact.name;
      if (!currentName) {
        // Empty → fill from anything.
        contactUpdates.name = message.contactName;
      } else if (
        !isLocked &&
        message.contactNameIsAuthoritative &&
        currentName !== message.contactName
      ) {
        // Authoritative correction allowed.
        contactUpdates.name = message.contactName;
      }
    }
    if (message.contactPhone && !existing.contact.phone) {
      contactUpdates.phone = message.contactPhone;
    }
    if (Object.keys(contactUpdates).length > 0) {
      const before = existing.contact.name;
      await this.prisma.contact.update({
        where: { id: existing.contactId },
        data: contactUpdates,
      });
      if (
        contactUpdates.name &&
        before &&
        before !== contactUpdates.name
      ) {
        this.logger.log(
          `Contact ${existing.contactId} name corrected via authoritative inbound: ` +
            `"${before}" → "${contactUpdates.name}"`,
        );
      }
    }
  }
}
