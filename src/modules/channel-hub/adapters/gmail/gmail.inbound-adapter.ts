import { Injectable } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import {
  ChannelLocator,
  InboundChannelPort,
} from '../../ports/inbound-channel.port';
import { VerificationResponse, WebhookParseResult } from '../../ports/types';

/**
 * Gmail MVP é pull (HistorySync). Webhook/PubSub fica pra fase 2.
 * Adapter inbound existe só pra satisfazer o registry.
 */
@Injectable()
export class GmailInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.GMAIL;

  extractLocators(): ChannelLocator[] {
    return [];
  }

  matchesChannel(_channel: Channel, _locator: ChannelLocator): boolean {
    return false;
  }

  validateWebhook(): boolean {
    return false;
  }

  parseWebhook(): WebhookParseResult {
    return { messages: [], statuses: [], errors: [] };
  }

  handleVerification(): VerificationResponse {
    return { statusCode: 404, body: 'Gmail channel does not use webhooks in v1' };
  }
}
