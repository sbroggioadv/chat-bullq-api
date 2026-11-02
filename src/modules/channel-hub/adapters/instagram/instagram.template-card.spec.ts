import { Channel } from '@prisma/client';
import {
  INSTAGRAM_EMPTY_GENERIC_CARD_TEXT,
  InstagramMessageMapper,
} from './instagram.message-mapper';
import { InstagramSyncAdapter } from './instagram.sync-adapter';
import { InstagramHttpClient } from './instagram.http-client';
import { MessageContentType } from '../../ports/types';

// SPEC-017 item 3 — cartão `generic` do Instagram nos dois caminhos de entrada.

const BUSINESS_ID = '17841448044331699';
const EXPECTED_TEXT = '[Cartão do Instagram — a Meta não enviou o conteúdo]';

const webhookEvent = (payload: unknown) => ({
  sender: { id: 'contact_ig' },
  recipient: { id: BUSINESS_ID },
  timestamp: 1762000000000,
  message: { mid: 'm_tpl', attachments: [{ type: 'template', payload }] },
});

function syncAdapterReturning(raw: Record<string, any>) {
  const httpClient = {
    resolveBusinessId: jest.fn(async () => BUSINESS_ID),
    listConversationMessages: jest.fn(async () => ({ data: [raw], nextCursor: undefined })),
  } as unknown as InstagramHttpClient;
  return new InstagramSyncAdapter(httpClient);
}

const syncRaw = (payload: unknown) => ({
  id: 'm_tpl_hist',
  created_time: '2026-10-20T10:00:00.000Z',
  from: { id: 'contact_ig', username: 'someone' },
  to: { data: [{ id: BUSINESS_ID }] },
  attachments: { data: [{ type: 'template', payload }] },
});

const channel = { id: 'ch1', type: 'INSTAGRAM' } as unknown as Channel;

describe('Cartão generic do Instagram — webhook (instagram.message-mapper)', () => {
  const mapper = new InstagramMessageMapper();

  it('a constante tem exatamente o texto pedido', () => {
    expect(INSTAGRAM_EMPTY_GENERIC_CARD_TEXT).toBe(EXPECTED_TEXT);
  });

  it('generic com elements vazio (shape medido em produção) grava o texto fixo', () => {
    const res = mapper.normalizeInbound(webhookEvent({ generic: { elements: [] } }));

    expect(res!.type).toBe(MessageContentType.TEMPLATE);
    expect(res!.content.text).toBe(EXPECTED_TEXT);
    expect(res!.content.mediaUrl).toBeUndefined();
    expect(res!.content.template?.templateType).toBe('generic');
  });

  it('generic no shape antigo (template_type + elements no payload) também vira o texto fixo', () => {
    const res = mapper.normalizeInbound(
      webhookEvent({ template_type: 'generic', elements: [] }),
    );

    expect(res!.content.text).toBe(EXPECTED_TEXT);
  });

  it('generic com itens extrai título/subtítulo para texto e a imagem para mediaUrl', () => {
    const res = mapper.normalizeInbound(
      webhookEvent({
        generic: {
          elements: [
            { title: 'Oferta', subtitle: 'Só hoje', image_url: 'https://scontent.xx.fbcdn.net/a.jpg' },
            { title: 'Segundo' },
          ],
        },
      }),
    );

    expect(res!.content.text).toBe('Oferta — Só hoje\nSegundo');
    expect(res!.content.mediaUrl).toBe('https://scontent.xx.fbcdn.net/a.jpg');
    expect(res!.content.template?.elements).toHaveLength(2);
  });

  it('defensivo: elementos nulos, sem chaves ou payload ausente não quebram', () => {
    const withJunk = mapper.normalizeInbound(
      webhookEvent({ generic: { elements: [null, 42, {}, { subtitle: 'só sub' }] } }),
    );
    const noPayload = mapper.normalizeInbound(webhookEvent(undefined));

    expect(withJunk!.content.text).toBe('só sub');
    expect(withJunk!.content.mediaUrl).toBeUndefined();
    expect(noPayload!.type).toBe(MessageContentType.TEMPLATE);
  });
});

describe('Cartão generic do Instagram — importação de histórico (instagram.sync-adapter)', () => {
  it('generic com elements vazio grava o texto fixo como TEMPLATE', async () => {
    const adapter = syncAdapterReturning(syncRaw({ generic: { elements: [] } }));

    const res = await adapter.fetchMessages(channel, 'conv1', {}, undefined, 50);

    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].type).toBe(MessageContentType.TEMPLATE);
    expect(res.messages[0].content.text).toBe(EXPECTED_TEXT);
  });

  it('generic com itens extrai texto e mediaUrl', async () => {
    const adapter = syncAdapterReturning(
      syncRaw({
        generic: { elements: [{ title: 'Oferta', image_url: 'https://scontent.cdninstagram.com/b.jpg' }] },
      }),
    );

    const res = await adapter.fetchMessages(channel, 'conv1', {}, undefined, 50);

    expect(res.messages[0].content.text).toBe('Oferta');
    expect(res.messages[0].content.mediaUrl).toBe('https://scontent.cdninstagram.com/b.jpg');
  });
});
