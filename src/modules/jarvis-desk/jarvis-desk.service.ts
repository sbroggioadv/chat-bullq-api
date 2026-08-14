import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelType,
  ChannelVisibility,
  ConversationStatus,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

const JARVIS_CHANNEL_NAME = 'Jarvis';
const JARVIS_CONTACT_NAME = 'Jarvis';

export interface JarvisDesk {
  channelId: string;
  conversationId: string;
  contactId: string;
}

@Injectable()
export class JarvisDeskService {
  private readonly logger = new Logger(JarvisDeskService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ensureDesk(organizationId: string): Promise<JarvisDesk> {
    const existing = await this.prisma.channel.findFirst({
      where: {
        organizationId,
        type: ChannelType.JARVIS,
        deletedAt: null,
      },
      select: { id: true },
    });

    const channel =
      existing ??
      (await this.prisma.channel.create({
        data: {
          organizationId,
          type: ChannelType.JARVIS,
          name: JARVIS_CHANNEL_NAME,
          config: { internal: true },
          isActive: true,
          visibility: ChannelVisibility.ORG,
          aiEnabled: true,
        },
        select: { id: true },
      }));

    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: {
        channelId: channel.id,
        externalId: `jarvis:${organizationId}`,
      },
      include: { contact: { select: { id: true } } },
    });

    let contactId = contactChannel?.contact.id;
    if (!contactId) {
      const contact = await this.prisma.contact.create({
        data: {
          organizationId,
          name: JARVIS_CONTACT_NAME,
          notes: 'Agente interno do BullQ — não é contato de atendimento.',
          metadata: { jarvis: true },
          channels: {
            create: {
              channelId: channel.id,
              externalId: `jarvis:${organizationId}`,
              profileName: JARVIS_CONTACT_NAME,
            },
          },
        },
        select: { id: true },
      });
      contactId = contact.id;
    }

    let conversation = await this.prisma.conversation.findFirst({
      where: {
        organizationId,
        channelId: channel.id,
        contactId,
        deletedAt: null,
      },
      select: { id: true, status: true, isArchived: true },
    });

    if (conversation && (conversation.status !== ConversationStatus.OPEN || conversation.isArchived)) {
      conversation = await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: ConversationStatus.OPEN, isArchived: false },
        select: { id: true, status: true, isArchived: true },
      });
    }

    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          organizationId,
          channelId: channel.id,
          contactId,
          status: ConversationStatus.OPEN,
          aiEnabled: true,
          subject: 'Jarvis',
        },
        select: { id: true, status: true, isArchived: true },
      });
      await this.seedWelcome(conversation.id);
      this.logger.log(`Jarvis desk created org=${organizationId} conv=${conversation.id}`);
    }

    return {
      channelId: channel.id,
      conversationId: conversation.id,
      contactId,
    };
  }

  isJarvisChannel(type: ChannelType): boolean {
    return type === ChannelType.JARVIS;
  }

  private async seedWelcome(conversationId: string): Promise<void> {
    await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.INBOUND,
        type: 'TEXT',
        status: MessageStatus.DELIVERED,
        content: {
          text:
            'Oi. Eu sou o Jarvis — moro aqui no BullQ. ' +
            'Pergunta como estão os chats, o que está preso, quem está sem resposta, ' +
            'ou como está o monitoramento. Eu olho o inbox de verdade; não atendo cliente.',
        },
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });
  }
}
