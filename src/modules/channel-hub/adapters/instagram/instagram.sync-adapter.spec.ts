import { Channel } from '@prisma/client';
import { InstagramSyncAdapter } from './instagram.sync-adapter';
import { InstagramHttpClient } from './instagram.http-client';
import { HistorySyncFilters } from '../../ports/types';

const BUSINESS_ID = '17841448044331699';

function buildConv(id: string, updatedIso: string, contactId = 'contact_' + id) {
  return {
    id,
    updated_time: updatedIso,
    participants: {
      data: [
        { id: BUSINESS_ID, username: 'luissbroggio' },
        { id: contactId, username: 'someone' },
      ],
    },
  };
}

function buildAdapter(listResult: { data: any[]; nextCursor?: string }) {
  const httpClient = {
    resolveBusinessId: jest.fn(async () => BUSINESS_ID),
    listConversations: jest.fn(async () => listResult),
  } as unknown as InstagramHttpClient;
  return { adapter: new InstagramSyncAdapter(httpClient), httpClient };
}

const channel = { id: 'ch1', type: 'INSTAGRAM' } as unknown as Channel;

describe('InstagramSyncAdapter.fetchConversations lookback early-stop', () => {
  // sinceTimestamp = corte de 7 dias
  const filters: HistorySyncFilters = {
    sinceTimestamp: new Date('2026-07-01T00:00:00.000Z'),
  };

  it('stops paginating (nextCursor undefined) when a conversation older than the lookback is reached', async () => {
    // Conversas em ordem DESC por updated_time; a 3ª está ANTES do corte.
    const { adapter } = buildAdapter({
      data: [
        buildConv('c1', '2026-07-05T10:00:00.000Z'), // dentro
        buildConv('c2', '2026-07-03T10:00:00.000Z'), // dentro
        buildConv('c3', '2026-06-20T10:00:00.000Z'), // ANTIGA → dispara o stop
        buildConv('c4', '2026-06-10T10:00:00.000Z'), // antiga
      ],
      nextCursor: 'CURSOR_NEXT_PAGE',
    });

    const result = await adapter.fetchConversations(channel, filters, undefined, 50);

    // só as 2 dentro da janela entram
    expect(result.conversations.map((c) => c.externalConversationId)).toEqual([
      'c1',
      'c2',
    ]);
    // e o loop PARA — sem isso o sync varre o histórico inteiro e a Meta corta com [#1]
    expect(result.nextCursor).toBeUndefined();
  });

  it('keeps paginating (preserves nextCursor) when every conversation is within the lookback', async () => {
    const { adapter } = buildAdapter({
      data: [
        buildConv('c1', '2026-07-06T10:00:00.000Z'),
        buildConv('c2', '2026-07-04T10:00:00.000Z'),
      ],
      nextCursor: 'CURSOR_NEXT_PAGE',
    });

    const result = await adapter.fetchConversations(channel, filters, undefined, 50);

    expect(result.conversations).toHaveLength(2);
    expect(result.nextCursor).toBe('CURSOR_NEXT_PAGE');
  });
});

describe('InstagramSyncAdapter.fetchMessages content extraction', () => {
  function buildAdapterWithMessages(messages: any[]) {
    const httpClient = {
      resolveBusinessId: jest.fn(async () => BUSINESS_ID),
      listConversationMessages: jest.fn(async () => ({ data: messages, nextCursor: undefined })),
    } as unknown as InstagramHttpClient;
    return new InstagramSyncAdapter(httpClient);
  }

  it('extracts the shared post/reel/story link instead of "[Unsupported message]"', async () => {
    const link = 'https://www.instagram.com/reel/ABC123/';
    const adapter = buildAdapterWithMessages([
      {
        id: 'm1',
        created_time: '2026-07-05T10:00:00.000Z',
        from: { id: 'contact_x', username: 'someone' },
        to: { data: [{ id: BUSINESS_ID }] },
        message: '', // share vem com message vazio
        shares: { data: [{ link }] },
      },
    ]);

    const res = await adapter.fetchMessages(channel, 'conv1', {}, undefined, 50);

    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].content.text).toBe(link);
    expect(res.messages[0].content.text).not.toBe('[Unsupported message]');
  });
});
