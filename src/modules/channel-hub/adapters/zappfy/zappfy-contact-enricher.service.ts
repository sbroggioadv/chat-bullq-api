import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { ZappfyHttpClient } from './zappfy.http-client';

/**
 * Pulls profile picture (and best-effort name) for a WhatsApp contact via
 * the Zappfy/uazapi `/chat/find` endpoint. Called lazily on inbound: if
 * the contact already has avatarUrl, we skip — saves a roundtrip per
 * incoming message.
 */
@Injectable()
export class ZappfyContactEnricherService {
  private readonly logger = new Logger(ZappfyContactEnricherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: ZappfyHttpClient,
  ) {}

  /**
   * S20 Wave 1: parametro `force` (opcional, default false). Quando true,
   * pula a check de "ja tem avatarUrl" e sempre re-fetch — usado pelo
   * backfill manual em /settings/contacts e pelo cron periodico (Wave 2)
   * que re-enriquece contatos com URLs antigas (URLs do WhatsApp expiram
   * em ~14 dias).
   *
   * Comportamento default (`force=false`) preservado pra inbound message
   * pipeline — economiza roundtrip Zappfy por mensagem nova.
   */
  async enrich(
    channel: Channel,
    externalContactId: string,
    options?: { force?: boolean },
  ): Promise<{ enriched: boolean; reason?: string }> {
    try {
      const contactChannel = await this.prisma.contactChannel.findUnique({
        where: {
          uq_contact_channel_external: {
            channelId: channel.id,
            externalId: externalContactId,
          },
        },
        include: { contact: true },
      });
      if (!contactChannel) return { enriched: false, reason: 'not_found' };

      // Skip if already enriched, EXCETO quando force=true (backfill/cron).
      if (!options?.force && contactChannel.contact.avatarUrl) {
        return { enriched: false, reason: 'already_has_avatar' };
      }

      const chat = await this.fetchChat(channel, externalContactId);
      if (!chat) return { enriched: false, reason: 'chat_not_found' };

      const avatarUrl: string | undefined = chat.wa_profilePicUrl || undefined;
      const profileName: string | undefined =
        chat.wa_contactName || chat.wa_name || undefined;

      if (!avatarUrl && !profileName) {
        return { enriched: false, reason: 'no_data_from_zappfy' };
      }

      const ccUpdates: Record<string, any> = {};
      if (profileName && profileName !== contactChannel.profileName) {
        ccUpdates.profileName = profileName;
      }
      if (avatarUrl && avatarUrl !== contactChannel.profileAvatarUrl) {
        ccUpdates.profileAvatarUrl = avatarUrl;
      }
      if (Object.keys(ccUpdates).length > 0) {
        await this.prisma.contactChannel.update({
          where: { id: contactChannel.id },
          data: ccUpdates,
        });
      }

      const contactUpdates: Record<string, any> = {};
      if (profileName && !contactChannel.contact.name) {
        contactUpdates.name = profileName;
      }
      // S20 Wave 1: com force=true, atualizamos avatarUrl mesmo quando ja
      // tinha valor (re-enrich pra URL nova que nao expirou). Sem force,
      // mantemos comportamento original (so seta se vazio).
      if (avatarUrl && (options?.force || !contactChannel.contact.avatarUrl)) {
        contactUpdates.avatarUrl = avatarUrl;
      }
      if (Object.keys(contactUpdates).length > 0) {
        await this.prisma.contact.update({
          where: { id: contactChannel.contactId },
          data: contactUpdates,
        });
      }

      this.logger.log(
        `Zappfy contact enriched${options?.force ? ' (forced)' : ''}: ${externalContactId} → ${profileName ?? '(no name)'} ${avatarUrl ? '+ avatar' : ''}`,
      );
      return { enriched: true };
    } catch (err: any) {
      this.logger.warn(
        `Zappfy contact enrichment failed for ${externalContactId}: ${err.message}`,
      );
      return { enriched: false, reason: 'error' };
    }
  }

  private async fetchChat(
    channel: Channel,
    chatId: string,
  ): Promise<any | null> {
    // /chat/find aceita filtros — passamos wa_chatid pra buscar o chat
    // exato e ler wa_profilePicUrl + wa_contactName / wa_name.
    try {
      const response = await this.httpClient.sendRequest(
        channel,
        '/chat/find',
        { wa_chatid: chatId, limit: 1 },
      );
      const chats = response?.chats ?? response?.data ?? response;
      return Array.isArray(chats) ? chats[0] : chats?.[0] ?? null;
    } catch (err: any) {
      this.logger.warn(
        `Zappfy fetchChat failed for ${chatId}: ${err.message}`,
      );
      return null;
    }
  }
}
