import { ChannelType, Channel } from '@prisma/client';
import { NormalizedOutboundMessage, SendResult, RateLimitConfig } from './types';

export interface OutboundChannelPort {
  readonly channelType: ChannelType;

  sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult>;

  sendTypingIndicator(
    channel: Channel,
    contactExternalId: string,
  ): Promise<void>;

  getMediaUrl(channel: Channel, mediaId: string): Promise<string>;

  downloadMedia(channel: Channel, mediaId: string): Promise<Buffer>;

  /**
   * Resolve an inbound message's media to a playable URL.
   *
   * Needed for channels like WhatsApp (Zappfy/Uazapi) where the webhook
   * delivers an encrypted .enc CDN URL that browsers cannot play — we must
   * hit the provider to get a decrypted URL. Channels where the webhook
   * already carries a playable URL (Instagram) can just echo the stored one.
   */
  resolveInboundMediaUrl?(
    channel: Channel,
    externalMessageId: string,
  ): Promise<{ fileUrl: string; mimeType?: string }>;

  getRateLimits(): RateLimitConfig;
}

export const OUTBOUND_CHANNEL_PORT = 'OUTBOUND_CHANNEL_PORT';
