import { Injectable } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  RateLimitConfig,
  SendResult,
} from '../../ports/types';

/**
 * Envio Gmail fica pra fase 2 (compose/reply).
 * MVP = visualizar caixa no inbox.
 */
@Injectable()
export class GmailOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.GMAIL;

  async sendMessage(
    _channel: Channel,
    _contactExternalId: string,
    _message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    throw new Error(
      'Gmail v1 é somente leitura. Responder pelo Gmail web/app; envio no BullQ vem na fase 2.',
    );
  }

  async sendTypingIndicator(): Promise<void> {
    /* no-op */
  }

  async getMediaUrl(): Promise<string> {
    throw new Error('Gmail v1 não resolve mídia outbound');
  }

  async downloadMedia(): Promise<Buffer> {
    throw new Error('Gmail v1 não baixa mídia outbound');
  }

  getRateLimits(): RateLimitConfig {
    return {
      maxPerSecond: 1,
      maxPerMinute: 30,
      windowMs: 60000,
    };
  }
}
