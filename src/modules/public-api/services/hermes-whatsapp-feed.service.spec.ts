import { BadRequestException } from '@nestjs/common';
import { MessageContentType, MessageDirection } from '@prisma/client';
import { HermesWhatsappFeedService } from './hermes-whatsapp-feed.service';

const INGESTED_AT = new Date('2026-07-13T18:00:00.000Z');

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    externalId: 'wamid-1',
    direction: MessageDirection.INBOUND,
    type: MessageContentType.TEXT,
    content: { text: 'Preciso falar sobre meu contrato' },
    senderName: 'Cliente Exemplo',
    senderId: null,
    providerTimestamp: new Date('2024-01-10T12:00:00.000Z'),
    createdAt: new Date('2024-01-10T12:00:00.000Z'),
    ingestedAt: INGESTED_AT,
    sender: null,
    conversation: {
      id: 'conv-1',
      channelId: 'channel-1',
      isGroup: false,
      subject: null,
      contact: {
        name: 'Cliente Exemplo',
        phone: '5517999999999',
        channels: [
          {
            channelId: 'channel-1',
            externalId: '5517999999999@s.whatsapp.net',
            profileName: 'Cliente Exemplo',
          },
        ],
      },
    },
    metadata: { rawPayload: { secret: true } },
    ...overrides,
  };
}

describe('HermesWhatsappFeedService', () => {
  const findMany = jest.fn();
  const prisma = { message: { findMany } } as any;
  let service: HermesWhatsappFeedService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-07-13T18:05:00.000Z'));
    service = new HermesWhatsappFeedService(prisma);
  });

  afterEach(() => jest.useRealTimers());

  it('should scope the query to the organization, accessible channels and WhatsApp types', async () => {
    findMany.mockResolvedValue([]);

    await service.getFeed('org-1', new Set(['channel-1', 'channel-2']), {
      limit: 50,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversation: expect.objectContaining({
            organizationId: 'org-1',
            channelId: { in: ['channel-1', 'channel-2'] },
            channel: {
              type: { in: ['WHATSAPP_ZAPPFY', 'WHATSAPP_OFFICIAL'] },
              deletedAt: null,
            },
          }),
        }),
        take: 51,
      }),
    );
  });

  it('should apply the requested directions inside the cursor query', async () => {
    findMany.mockResolvedValue([]);

    await service.getFeed('org-1', 'ALL', {
      limit: 100,
      directions: [MessageDirection.INBOUND],
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: { in: [MessageDirection.INBOUND] },
        }),
      }),
    );
  });

  it('should return no messages without querying when the key has no channel access', async () => {
    const result = await service.getFeed('org-1', new Set(), { limit: 100 });

    expect(findMany).not.toHaveBeenCalled();
    expect(result.messages).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it('should export inbound and outbound messages with a minimal safe projection', async () => {
    findMany.mockResolvedValue([
      messageRow(),
      messageRow({
        id: 'msg-2',
        externalId: 'wamid-2',
        direction: MessageDirection.OUTBOUND,
        senderName: null,
        senderId: 'user-luis',
        sender: { name: 'Luis Sbroggio' },
        ingestedAt: new Date('2026-07-13T18:00:01.000Z'),
      }),
    ]);

    const result = await service.getFeed('org-1', 'ALL', { limit: 100 });

    expect(result.schema).toBe('bullq.hermes.whatsapp-feed.v1');
    expect(result.generated_at).toBe('2026-07-13T18:05:00.000Z');
    expect(result.messages.map((message) => message.direction)).toEqual([
      'INBOUND',
      'OUTBOUND',
    ]);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        id: 'msg-1',
        external_message_id: 'wamid-1',
        conversation_id: 'conv-1',
        channel_id: 'channel-1',
        chat_id: '5517999999999@s.whatsapp.net',
        conversation_name: 'Cliente Exemplo',
        is_group: false,
        sender_name: 'Cliente Exemplo',
        sender_user_id: null,
        sender_user_name: null,
        type: 'TEXT',
        text: 'Preciso falar sobre meu contrato',
        provider_timestamp: '2024-01-10T12:00:00.000Z',
        ingested_at: '2026-07-13T18:00:00.000Z',
      }),
    );
    expect(result.messages[1].sender_user_name).toBe('Luis Sbroggio');
    expect(result.messages[1].sender_user_id).toBe('user-luis');
    expect(JSON.stringify(result)).not.toContain('rawPayload');
    expect(JSON.stringify(result)).not.toContain('5517999999999\"');
    expect(Object.keys(result.messages[0])).not.toContain('metadata');
  });

  it('should use ingestedAt and id as the cursor tie-breaker', async () => {
    const cursor = HermesWhatsappFeedService.encodeCursor({
      ingestedAt: INGESTED_AT,
      id: 'msg-1',
    });
    findMany.mockResolvedValue([
      messageRow({ id: 'msg-2' }),
      messageRow({ id: 'msg-3' }),
    ]);

    const result = await service.getFeed('org-1', 'ALL', { cursor, limit: 1 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { ingestedAt: { gt: INGESTED_AT } },
            { ingestedAt: INGESTED_AT, id: { gt: 'msg-1' } },
          ],
        }),
        orderBy: [{ ingestedAt: 'asc' }, { id: 'asc' }],
        take: 2,
      }),
    );
    expect(result.messages.map((message) => message.id)).toEqual(['msg-2']);
    expect(result.has_more).toBe(true);
    expect(HermesWhatsappFeedService.decodeCursor(result.next_cursor!)).toEqual({
      ingestedAt: INGESTED_AT,
      id: 'msg-2',
    });
  });

  it('should advance historical imports by ingestion time instead of provider time', async () => {
    findMany.mockResolvedValue([messageRow()]);

    const result = await service.getFeed('org-1', 'ALL', { limit: 100 });
    const decoded = HermesWhatsappFeedService.decodeCursor(result.next_cursor!);

    expect(result.messages[0].provider_timestamp).toBe('2024-01-10T12:00:00.000Z');
    expect(decoded.ingestedAt).toEqual(INGESTED_AT);
  });

  it.each([
    'not-base64!',
    Buffer.from('{}').toString('base64url'),
    Buffer.from('{"ingestedAt":"bad","id":"msg-1"}').toString('base64url'),
  ])('should reject malformed cursor %s', async (cursor) => {
    await expect(
      service.getFeed('org-1', 'ALL', { cursor, limit: 100 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([0, -1, 1.5, 201, Number.NaN])(
    'should reject invalid limit %s',
    async (limit) => {
      await expect(service.getFeed('org-1', 'ALL', { limit })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it('should scope a conversation context lookup to tenant, channel access and WhatsApp', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const scopedService = new HermesWhatsappFeedService({
      message: { findMany },
      conversation: { findFirst },
    } as any);

    await scopedService.getConversation(
      'org-1',
      new Set(['channel-1']),
      'conv-other-tenant',
      20,
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'conv-other-tenant',
          organizationId: 'org-1',
          channelId: { in: ['channel-1'] },
          deletedAt: null,
          channel: {
            type: { in: ['WHATSAPP_ZAPPFY', 'WHATSAPP_OFFICIAL'] },
            deletedAt: null,
          },
        },
      }),
    );
  });

  it('should calculate health without selecting message content', async () => {
    const groupBy = jest.fn().mockResolvedValue([
      { direction: MessageDirection.INBOUND, _count: { _all: 3 } },
      { direction: MessageDirection.OUTBOUND, _count: { _all: 2 } },
    ]);
    const findFirst = jest.fn().mockResolvedValue({ ingestedAt: INGESTED_AT });
    const scopedService = new HermesWhatsappFeedService({
      message: { findMany, groupBy, findFirst },
    } as any);

    const result = await scopedService.getHealth('org-1', 'ALL');

    expect(result).toEqual(
      expect.objectContaining({
        total_messages: 5,
        inbound_messages: 3,
        outbound_messages: 2,
        latest_ingested_at: INGESTED_AT.toISOString(),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: { ingestedAt: true } }),
    );
    expect(JSON.stringify(findFirst.mock.calls[0][0])).not.toContain('content');
  });
});
