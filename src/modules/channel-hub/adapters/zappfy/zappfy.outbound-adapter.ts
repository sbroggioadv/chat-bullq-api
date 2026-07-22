import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import axios from 'axios';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { ZappfyMessageMapper } from './zappfy.message-mapper';
import { ZappfyHttpClient } from './zappfy.http-client';

@Injectable()
export class ZappfyOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_ZAPPFY;
  private readonly logger = new Logger(ZappfyOutboundAdapter.name);

  constructor(
    private readonly mapper: ZappfyMessageMapper,
    private readonly httpClient: ZappfyHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const denormalized = this.mapper.denormalize(message, contactExternalId);

    let response: any;
    if (denormalized.fileUpload) {
      try {
        response = await this.sendMultipart(
          channel,
          denormalized.endpoint,
          denormalized.payload,
          denormalized.fileUpload,
        );
      } catch (error: any) {
        // SPEC-003 W2: never lose the send — fall back to JSON + friendly URL.
        this.logger.warn(
          `Multipart upload failed (${error.message}); falling back to JSON media URL for ${contactExternalId}`,
        );
        const fallbackPayload = {
          ...denormalized.payload,
          file:
            denormalized.fileUpload.friendlyUrl ||
            denormalized.fileUpload.url ||
            denormalized.payload.file,
        };
        response = await this.httpClient.sendRequest(
          channel,
          denormalized.endpoint,
          fallbackPayload,
        );
      }
    } else {
      response = await this.httpClient.sendRequest(
        channel,
        denormalized.endpoint,
        denormalized.payload,
      );
    }

    return {
      // Prefer `messageid` — the send response returns `id` as `<owner>:<msgid>`
      // but webhook echoes only carry the bare `<msgid>` in `messageid`. Using
      // the same shape on both sides keeps the unique (conversationId,externalId)
      // matching so the echo merges into our placeholder instead of duplicating.
      externalId:
        response?.messageid ||
        response?.key?.id ||
        response?.id ||
        '',
      providerResponse: response,
    };
  }

  private async sendMultipart(
    channel: Channel,
    endpoint: string,
    payload: Record<string, any>,
    fileUpload: { url: string; name: string; mimeType?: string; friendlyUrl?: string },
  ): Promise<any> {
    this.logger.log(
      `Downloading file for multipart upload: ${fileUpload.url} (name: ${fileUpload.name})`,
    );
    const fileResponse = await axios.get(fileUpload.url, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    const buffer = Buffer.from(fileResponse.data);
    const headerMime = fileResponse.headers['content-type'];
    const mimeType =
      fileUpload.mimeType ||
      (typeof headerMime === 'string' ? headerMime : undefined) ||
      'application/octet-stream';

    this.logger.log(
      `File downloaded: ${fileUpload.name}, size: ${buffer.length}, mime: ${mimeType}`,
    );

    // Payload fields for multipart must not include the remote `file` URL —
    // the binary goes in the form file field with the original filename.
    const { file: _omitFile, ...fields } = payload;
    return this.httpClient.sendMultipartRequest(
      channel,
      endpoint,
      fields,
      buffer,
      fileUpload.name,
      mimeType,
    );
  }

  async sendTypingIndicator(
    channel: Channel,
    contactExternalId: string,
  ): Promise<void> {
    const number = contactExternalId.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    try {
      await this.httpClient.sendRequest(channel, '/message/presence', {
        number,
        presence: 'composing',
      });
    } catch (error: any) {
      this.logger.warn(`Typing indicator failed: ${error.message}`);
    }
  }

  async getMediaUrl(channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(channel: Channel, mediaId: string): Promise<Buffer> {
    return this.httpClient.getMediaBuffer(channel, mediaId);
  }

  async resolveInboundMediaUrl(
    channel: Channel,
    hint: { externalMessageId: string },
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    return this.httpClient.resolveInboundMediaUrl(channel, hint.externalMessageId);
  }

  async deleteMessage(
    channel: Channel,
    externalMessageId: string,
  ): Promise<void> {
    await this.httpClient.deleteMessage(channel, externalMessageId);
  }

  getRateLimits(): RateLimitConfig {
    return {
      maxPerSecond: 1,
      maxPerMinute: 30,
      windowMs: 60000,
    };
  }
}
