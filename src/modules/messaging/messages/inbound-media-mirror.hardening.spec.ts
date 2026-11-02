import * as dns from 'dns';
import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { Channel } from '@prisma/client';
import { InboundMediaMirrorService } from './inbound-media-mirror.service';
import {
  MediaHttpGet,
  MediaHttpResponse,
  MetaMediaDownloader,
  isPrivateAddress,
  safeLookup,
} from './meta-media-downloader';
import { UploadsService } from './uploads.service';
import { HistoryImportService } from '../pipeline/history-import.service';

// SPEC-017 rodada 2 — correções do parecer independente (achados 1, 2, 3, 5, 7, 8).
// Usa só a API pública que já existia no HEAD da rodada 1, para que o controle
// negativo falhe por comportamento e não por compilação.

const CDN_MEDIA = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&oh=TOKEN_A';
const CDN_STORY = 'https://scontent.cdninstagram.com/v/story.jpg?oh=TOKEN_B';
const OURS = 'https://api.bullq.test/api/v1/uploads/inbound/ch1/2026-11-02/abc.jpg';

const ok = (over: Partial<MediaHttpResponse> = {}): MediaHttpResponse => ({
  status: 200,
  headers: { 'content-type': 'image/jpeg' },
  data: Buffer.from([1, 2, 3]),
  ...over,
});

/** Linha de mensagem como o worker a lê (factory com defaults). */
const row = (over: Record<string, any> = {}) => ({
  id: 'msg-1',
  direction: 'INBOUND',
  type: 'IMAGE',
  conversationId: 'conv-1',
  content: { mediaUrl: CDN_MEDIA },
  metadata: {},
  conversation: { metadata: {} },
  ...over,
});

function harness(opts: { message?: any; http?: MediaHttpGet } = {}) {
  const message = opts.message ?? row();
  const prisma: any = {
    message: {
      findUnique: jest.fn(async () => message),
      findMany: jest.fn(async () => [message]),
      update: jest.fn(),
    },
    conversation: { findUnique: jest.fn(async () => message.conversation ?? { metadata: {} }) },
    $executeRaw: jest.fn(async () => 1),
  };
  const uploads = {
    saveInboundMedia: jest.fn(async () => ({ url: OURS, mimeType: 'image/jpeg', size: 3, filename: 'abc.jpg' })),
  } as unknown as UploadsService;
  const http = jest.fn(opts.http ?? (async () => ok()));
  const queue = { add: jest.fn(async () => ({})) };
  const service = new InboundMediaMirrorService(
    prisma,
    uploads,
    MetaMediaDownloader.withTransport(http),
    queue as any,
  );
  return { service, prisma, uploads, http, queue };
}

const rawSql = (prisma: any) =>
  prisma.$executeRaw.mock.calls.map(([strings, ...values]: [TemplateStringsArray, ...unknown[]]) => ({
    sql: strings.join('?').replace(/\s+/g, ' '),
    values,
  }));

const PENDING = Symbol('pending');
/** Resolve com o valor da promessa ou com PENDING se ela não terminar a tempo. */
const settleOrPending = <T>(p: Promise<T>, ms = 300) =>
  Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);

beforeEach(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

// ─── Achado 1 — importação não espera a fila ───────────────────────────────

describe('Achado 1: a importação não espera o enfileiramento', () => {
  const igChannel = { id: 'ch1', type: 'INSTAGRAM' } as unknown as Channel;
  const imported = [
    {
      externalMessageId: 'm1',
      externalConversationId: 'c',
      externalContactId: 'x',
      direction: 'INBOUND',
      timestamp: new Date('2026-10-30T10:00:00Z'),
      type: 'IMAGE',
      content: { mediaUrl: CDN_MEDIA },
    } as any,
  ];
  const importerWith = (h: ReturnType<typeof harness>) => {
    const tx: any = {
      conversation: { findUnique: jest.fn(async () => ({ metadata: {} })), updateMany: jest.fn() },
      message: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => ({ count: 1 })) },
    };
    return new HistoryImportService({ $transaction: jest.fn((fn: any) => fn(tx)) } as any, {} as any, h.service);
  };

  it.each([
    ['fica pendente para sempre', () => new Promise(() => undefined)],
    ['rejeita', () => Promise.reject(new Error('redis down'))],
  ])('queue.add que %s não segura a importação', async (_label, addImpl) => {
    const h = harness();
    h.queue.add.mockImplementation(addImpl as any);

    const outcome = await settleOrPending(importerWith(h).importMessages(igChannel, 'conv', imported));

    expect(outcome).toEqual({ imported: 1, skipped: 0 });
  });

  it('busca no banco pendente também não segura a importação', async () => {
    const h = harness();
    h.prisma.message.findMany.mockImplementation(() => new Promise(() => undefined));

    const outcome = await settleOrPending(importerWith(h).importMessages(igChannel, 'conv', imported));

    expect(outcome).toEqual({ imported: 1, skipped: 0 });
  });
});

// ─── Achado 2 — prazo único de 20 s para o download inteiro ────────────────

describe('Achado 2: prazo único somando todos os saltos', () => {
  const T0 = 1_762_000_000_000;
  const redirect = ok({ status: 302, headers: { location: 'https://scontent.xx.fbcdn.net/next.jpg' } });

  /**
   * Transporte que gasta `costMs` do relógio por salto. Como o axios real, ele
   * respeita o prazo recebido: se o salto custaria mais, gasta só o prazo e
   * falha com ECONNABORTED. Anota o prazo recebido e o tempo gasto.
   */
  function slowTransport(costMs: number, responses: MediaHttpResponse[]) {
    let clock = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const given: number[] = [];
    const spent: number[] = [];
    const http = jest.fn(async (_url: string, opts: { timeoutMs: number }) => {
      given.push(opts.timeoutMs);
      const used = Math.min(costMs, opts.timeoutMs);
      clock += used;
      spent.push(used);
      if (costMs > opts.timeoutMs) {
        throw Object.assign(new Error('timeout exceeded'), { code: 'ECONNABORTED' });
      }
      return responses.shift() ?? ok();
    });
    return { http, given, spent };
  }

  it('cada salto recebe só o tempo restante e a soma dos tempos não passa de 20 s', async () => {
    const { http, given, spent } = slowTransport(8_000, [redirect, redirect, redirect, ok()]);

    const err = await MetaMediaDownloader.withTransport(http).download(CDN_MEDIA).catch((e) => e);

    expect(given).toEqual([20_000, 12_000, 4_000]);
    expect(spent.reduce((a, b) => a + b, 0)).toBe(20_000);
    expect(err.reason).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(http).toHaveBeenCalledTimes(3);
  });

  it('dentro do prazo, o redirecionamento continua funcionando', async () => {
    const { http, given, spent } = slowTransport(1_000, [redirect, ok()]);

    const media = await MetaMediaDownloader.withTransport(http).download(CDN_MEDIA);

    expect(media.host).toBe('scontent.xx.fbcdn.net');
    expect(given).toEqual([20_000, 19_000]);
    expect(spent.reduce((a, b) => a + b, 0)).toBe(2_000);
  });
});

// ─── Achado 5 — campos independentes ──────────────────────────────────────

describe('Achado 5: mediaUrl e story.url são tentados e registrados de forma independente', () => {
  /** Transporte por URL: cada link tem sua resposta. */
  const byUrl = (map: Record<string, MediaHttpResponse>) => async (url: string) =>
    map[url] ?? ok();
  const twoFields = (metadata: Record<string, any> = {}) =>
    row({
      type: 'TEXT',
      content: { text: 'amei', mediaUrl: CDN_MEDIA },
      metadata: { replyTo: { story: { url: CDN_STORY, kind: 'reply' } }, ...metadata },
    });
  const recordedFields = (prisma: any) =>
    rawSql(prisma)
      .filter((c: any) => c.sql.includes("'failed'"))
      .map((c: any) => c.values[0]);

  it('404 em mediaUrl + erro transitório em story.url: tenta os dois, registra só a mídia e retenta o job', async () => {
    const h = harness({
      message: twoFields(),
      http: byUrl({ [CDN_MEDIA]: ok({ status: 404 }), [CDN_STORY]: ok({ status: 503 }) }),
    });

    const err = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false }).catch((e) => e);

    expect(h.http.mock.calls.map((c) => c[0])).toEqual([CDN_MEDIA, CDN_STORY]);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe('http_status:503');
    expect(recordedFields(h.prisma)).toEqual(['media']);
  });

  it('na retentativa, o campo com desistência registrada não é tentado de novo', async () => {
    const h = harness({
      message: twoFields({ mediaMirror: { media: { status: 'failed', reason: 'http_status', httpStatus: 404 } } }),
    });

    const res = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });

    expect(h.http.mock.calls.map((c) => c[0])).toEqual([CDN_STORY]);
    expect(res).toEqual({ status: 'mirrored', fields: ['story'] });
  });

  it('404 em mediaUrl não impede a story de ser espelhada; o job desiste só da mídia', async () => {
    const h = harness({ message: twoFields(), http: byUrl({ [CDN_MEDIA]: ok({ status: 404 }) }) });

    const err = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false }).catch((e) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(rawSql(h.prisma).some((c: any) => c.sql.includes('{replyTo,story,url}') && c.values[0] === OURS)).toBe(true);
    expect(recordedFields(h.prisma)).toEqual(['media']);
  });

  it('última tentativa: registra a falha de cada campo separadamente', async () => {
    const h = harness({
      message: twoFields(),
      http: byUrl({ [CDN_MEDIA]: ok({ status: 404 }), [CDN_STORY]: ok({ status: 503 }) }),
    });

    const err = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: true }).catch((e) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(recordedFields(h.prisma)).toEqual(['media', 'story']);
  });
});

// ─── Achado 8 — conversa extra fundida pela limpeza ───────────────────────

describe('Achado 8: extra fundida não recebe escrita; arquivada pelo usuário sim', () => {
  it('conversa com cleanup_merged_into: não baixa, não escreve, não retenta', async () => {
    const h = harness({ message: row({ conversation: { metadata: { cleanup_merged_into: 'conv-original' } } }) });

    const res = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });

    expect(res).toEqual({ status: 'skipped', reason: 'conversation_merged' });
    expect(h.http).not.toHaveBeenCalled();
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(h.prisma.message.update).not.toHaveBeenCalled();
  });

  it('conversa arquivada pelo usuário (sem a marca) é espelhada normalmente', async () => {
    const h = harness({ message: row({ conversation: { isArchived: true, metadata: { archivedBy: 'user-1' } } }) });

    const res = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });

    expect(res).toEqual({ status: 'mirrored', fields: ['media'] });
  });

  it('todo UPDATE repete a checagem da marca no WHERE (fusão entre a leitura e a escrita)', async () => {
    const h = harness({ http: async () => ok({ status: 404 }) });
    const swap = harness();

    await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: true }).catch(() => undefined);
    await swap.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });

    const all = [...rawSql(h.prisma), ...rawSql(swap.prisma)];
    expect(all.length).toBe(2);
    for (const c of all) {
      expect(c.sql).toContain(`NOT EXISTS ( SELECT 1 FROM "conversations" c WHERE c."id" = "messages"."conversation_id"`);
      expect(c.sql).toContain(`'cleanup_merged_into'`);
    }
  });
});

// ─── Achado 7 — eco e mensagens enviadas ──────────────────────────────────

describe('Achado 7: eco do Instagram é espelhado; enviada pelo BullQ não', () => {
  it('eco (OUTBOUND) com mídia no CDN da Meta é enfileirado', async () => {
    const h = harness();

    const queued = await h.service.enqueueForMessage(row({ direction: 'OUTBOUND' }), 'ch1');

    expect(queued).toBe(true);
    expect(h.queue.add).toHaveBeenCalledWith('mirror', { messageId: 'msg-1', channelId: 'ch1' }, expect.anything());
  });

  it('enviada pelo BullQ (URL já nossa) não é enfileirada', async () => {
    const h = harness();

    const queued = await h.service.enqueueForMessage(
      row({ direction: 'OUTBOUND', content: { mediaUrl: OURS } }),
      'ch1',
    );

    expect(queued).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('eco com host fora da lista continua fora', async () => {
    const h = harness();

    const queued = await h.service.enqueueForMessage(
      row({ direction: 'OUTBOUND', content: { mediaUrl: 'https://evil.example.com/a.jpg' } }),
      'ch1',
    );

    expect(queued).toBe(false);
  });

  it('webhook de eco (is_echo) do Instagram chega ao enfileiramento', async () => {
    const { InboundMessageProcessor } = await import('../pipeline/inbound-message.processor');
    const { InstagramMessageMapper } = await import('../../channel-hub/adapters/instagram/instagram.message-mapper');
    const mirror = { enqueueForMessage: jest.fn(async () => true) };
    const prisma: any = {
      channel: { findUnique: jest.fn(async () => null) },
      contact: { findUnique: jest.fn(async () => ({ name: 'x', avatarUrl: 'y' })) },
      conversation: { findUnique: jest.fn(async () => ({ metadata: {} })), update: jest.fn() },
      message: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: 'msg-echo', ...data })),
      },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    const processor = new InboundMessageProcessor(
      prisma,
      { claimProcessing: jest.fn(async () => true), markProcessed: jest.fn(), releaseClaim: jest.fn() } as any,
      { resolve: jest.fn(async () => ({ contactId: 'contact', isNew: false })) } as any,
      { resolve: jest.fn(async () => ({ conversationId: 'conv', status: 'OPEN' })) } as any,
      { emitToChannel: jest.fn(), emitToConversation: jest.fn() } as any,
      {} as any, {} as any, { markProcessed: jest.fn(), markFailed: jest.fn() } as any,
      {} as any, {} as any, {} as any, { enqueue: jest.fn() } as any,
      { scheduleCheck: jest.fn(async () => undefined), cancelCheck: jest.fn(async () => undefined) } as any,
      { add: jest.fn() } as any,
      mirror as any,
    );
    const echo = new InstagramMessageMapper().normalizeInbound({
      sender: { id: 'our_ig' },
      recipient: { id: 'contact_ig' },
      timestamp: 1762000000000,
      message: { mid: 'm_echo', is_echo: true, attachments: [{ type: 'image', payload: { url: CDN_MEDIA } }] },
    })!;

    await processor.process({ name: 'process-inbound', data: { channelId: 'ch1', organizationId: 'org', message: echo } } as any);

    expect(mirror.enqueueForMessage).toHaveBeenCalledTimes(1);
    const [saved] = mirror.enqueueForMessage.mock.calls[0] as any[];
    expect(saved.direction).toBe('OUTBOUND');
    expect(saved.content.mediaUrl).toBe(CDN_MEDIA);
  });

  it('importação enfileira eco histórico com mídia do CDN da Meta', async () => {
    const h = harness({ message: row({ id: 'msg-out', direction: 'OUTBOUND' }) });
    const tx: any = {
      conversation: { findUnique: jest.fn(async () => ({ metadata: {} })), updateMany: jest.fn() },
      message: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => ({ count: 1 })) },
    };
    const importer = new HistoryImportService({ $transaction: jest.fn((fn: any) => fn(tx)) } as any, {} as any, h.service);

    await importer.importMessages({ id: 'ch1', type: 'INSTAGRAM' } as unknown as Channel, 'conv', [
      { externalMessageId: 'm_out', externalConversationId: 'c', externalContactId: 'x', direction: 'OUTBOUND', timestamp: new Date('2026-10-30T10:00:00Z'), type: 'IMAGE', content: { mediaUrl: CDN_MEDIA } } as any,
    ]);
    await new Promise((r) => setImmediate(r));

    expect(h.queue.add).toHaveBeenCalledWith('mirror', { messageId: 'msg-out', channelId: 'ch1' }, expect.anything());
  });
});

// ─── Achado 3 — IPv6 especial, por DNS simulado ────────────────────────────

describe('Achado 3: o lookup recusa toda faixa especial (DNS simulado)', () => {
  /** Roda safeLookup com o DNS devolvendo exatamente `address`. */
  function lookupResolvingTo(address: string, opts: dns.LookupOptions = {}) {
    const family = address.includes(':') ? 6 : 4;
    (jest.spyOn(dns, 'lookup') as unknown as jest.Mock).mockImplementationOnce(
      (_h: string, _o: unknown, cb: any) => cb(null, [{ address, family }]),
    );
    return new Promise<{ err: any; address: any }>((resolve) =>
      safeLookup('lookaside.fbsbx.com', opts, (err, addr) => resolve({ err, address: addr })),
    );
  }

  it.each([
    ['::127.0.0.1', '::/96 compatível IPv4 (loopback)'],
    ['::10.0.0.1', '::/96 compatível IPv4 (privado)'],
    ['::ffff:127.0.0.1', '::ffff:0:0/96 mapeado (decimal)'],
    ['::ffff:7f00:1', '::ffff:0:0/96 mapeado (hexadecimal)'],
    ['::ffff:157.240.12.35', '::ffff:0:0/96 mapeado, mesmo de IP público'],
    ['64:ff9b::7f00:1', 'NAT64 64:ff9b::/96'],
    ['64:ff9b::a00:1', 'NAT64 64:ff9b::/96 para 10.0.0.1'],
    ['64:ff9b:1::a00:1', 'NAT64 local 64:ff9b:1::/48'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo 2001::/32'],
    ['2001:db8::1', 'documentação 2001:db8::/32'],
    ['2002:7f00:1::1', '6to4 2002::/16 (embute 127.0.0.1)'],
    ['2002:9df0:c23::1', '6to4 2002::/16 (embute IP público)'],
    ['fc00::1', 'ULA fc00::/7'],
    ['fd12:3456::1', 'ULA fc00::/7 (fd)'],
    ['fe80::1', 'link-local fe80::/10'],
    ['::1', 'loopback'],
    ['::', 'não especificado'],
    ['ff02::1', 'multicast'],
    ['0.0.0.0', 'IPv4 0/8'],
    ['10.1.2.3', 'IPv4 10/8'],
    ['100.64.0.1', 'IPv4 CGNAT 100.64/10'],
    ['127.0.0.1', 'IPv4 loopback'],
    ['169.254.169.254', 'IPv4 link-local / metadados de nuvem'],
    ['172.16.5.4', 'IPv4 172.16/12'],
    ['192.0.0.8', 'IPv4 192.0.0/24'],
    ['192.168.0.10', 'IPv4 192.168/16'],
    ['198.18.0.1', 'IPv4 benchmark 198.18/15'],
    ['224.0.0.1', 'IPv4 multicast'],
    ['255.255.255.255', 'IPv4 broadcast'],
  ])('recusa %s (%s)', async (address) => {
    const res = await lookupResolvingTo(address);

    expect(res.err?.code).toBe('EPRIVATEADDR');
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([['157.240.12.35'], ['31.13.85.8'], ['2a03:2880:f12f:83:face:b00c:0:25de']])(
    'deixa passar endereço público %s',
    async (address) => {
      const single = await lookupResolvingTo(address);
      const all = await lookupResolvingTo(address, { all: true });

      expect(single.err).toBeNull();
      expect(single.address).toBe(address);
      expect(all.address).toEqual([{ address, family: address.includes(':') ? 6 : 4 }]);
    },
  );

  it('recusa se QUALQUER endereço da resposta for especial', async () => {
    (jest.spyOn(dns, 'lookup') as unknown as jest.Mock).mockImplementationOnce(
      (_h: string, _o: unknown, cb: any) =>
        cb(null, [
          { address: '2a03:2880:f12f:83:face:b00c:0:25de', family: 6 },
          { address: '64:ff9b::a9fe:a9fe', family: 6 },
        ]),
    );

    const res = await new Promise<any>((resolve) =>
      safeLookup('lookaside.fbsbx.com', {}, (err) => resolve(err)),
    );

    expect(res?.code).toBe('EPRIVATEADDR');
  });
});
