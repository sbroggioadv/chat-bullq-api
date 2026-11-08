import * as dns from 'dns';
import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { Channel, ConversationStatus } from '@prisma/client';
import {
  INBOUND_MEDIA_MIRROR_QUEUE,
  InboundMediaMirrorService,
  MIRROR_JOB_ATTEMPTS,
  mirrorBackoffStrategy,
} from './inbound-media-mirror.service';
import {
  MediaDownloadError,
  MediaHttpGet,
  MediaHttpResponse,
  META_MEDIA_TIMEOUT_MS,
  MetaMediaDownloader,
  isPrivateAddress,
  safeLookup,
} from './meta-media-downloader';
import { UploadsService } from './uploads.service';
import { InboundMessageProcessor } from '../pipeline/inbound-message.processor';
import { HistoryImportService } from '../pipeline/history-import.service';
import { InstagramMessageMapper } from '../../channel-hub/adapters/instagram/instagram.message-mapper';
import { InstagramSyncAdapter } from '../../channel-hub/adapters/instagram/instagram.sync-adapter';
import { InstagramHttpClient } from '../../channel-hub/adapters/instagram/instagram.http-client';

// SPEC-017 itens 1 e 2 — espelhamento da mídia do Instagram e travas de download.

const SECRET = 'oh=SIGNED_TOKEN_123&oe=6720ABCD';
const CDN_URL = `https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=987&${SECRET}`;
const OURS = 'https://api.bullq.test/api/v1/uploads/inbound/ch1/2026-11-02/abc.jpg';

// ─── factories ─────────────────────────────────────────────────────────────

const ok = (over: Partial<MediaHttpResponse> = {}): MediaHttpResponse => ({
  status: 200,
  headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
  data: Buffer.from([1, 2, 3, 4]),
  ...over,
});

function transport(...responses: Array<MediaHttpResponse | Error>) {
  const queue = [...responses];
  return jest.fn<ReturnType<MediaHttpGet>, Parameters<MediaHttpGet>>(async () => {
    const next = queue.shift() ?? ok();
    if (next instanceof Error) throw next;
    return next;
  });
}

const storyMention = (over: Record<string, any> = {}) => ({
  id: 'msg-1',
  direction: 'INBOUND',
  type: 'TEXT',
  content: { text: '[Story mention]', mediaUrl: CDN_URL },
  metadata: { replyTo: { story: { url: CDN_URL, kind: 'mention' } } },
  ...over,
});

function harness(opts: { row?: any; http?: ReturnType<typeof transport> } = {}) {
  let row = opts.row === undefined ? storyMention() : opts.row;
  const prisma: any = {
    message: {
      findUnique: jest.fn(async () => row),
      findMany: jest.fn(async () => (row ? [row] : [])),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $executeRaw: jest.fn(async () => 1),
  };
  const uploads = {
    saveInboundMedia: jest.fn(async () => ({ url: OURS, mimeType: 'image/jpeg', size: 4, filename: 'abc.jpg' })),
  } as unknown as UploadsService;
  const http = opts.http ?? transport();
  const downloader = MetaMediaDownloader.withTransport(http);
  const queue = { add: jest.fn(async () => ({})) };
  const service = new InboundMediaMirrorService(prisma, uploads, downloader, queue as any);
  return {
    service,
    prisma,
    uploads,
    http,
    queue,
    setRow: (r: any) => (row = r),
  };
}

/** SQL + valores de cada chamada de $executeRaw (tagged template). */
const rawCalls = (prisma: any) =>
  prisma.$executeRaw.mock.calls.map(([strings, ...values]: [TemplateStringsArray, ...unknown[]]) => ({
    sql: strings.join('?').replace(/\s+/g, ' '),
    values,
  }));

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  }
});
afterEach(() => jest.restoreAllMocks());

// ─── download seguro ───────────────────────────────────────────────────────

describe('MetaMediaDownloader — travas de SSRF e abuso', () => {
  it('feliz: baixa image/* do host permitido com timeout de 20 s e teto MAX_INBOUND_BYTES', async () => {
    const http = transport(ok());
    const d = MetaMediaDownloader.withTransport(http);

    const media = await d.download(CDN_URL);

    expect(media.mimeType).toBe('image/jpeg');
    expect(media.host).toBe('lookaside.fbsbx.com');
    expect(http).toHaveBeenCalledWith(CDN_URL, {
      timeoutMs: 20_000,
      maxBytes: UploadsService.MAX_INBOUND_BYTES,
    });
    expect(new MetaMediaDownloader().limits).toEqual({
      maxBytes: UploadsService.MAX_INBOUND_BYTES,
      timeoutMs: META_MEDIA_TIMEOUT_MS,
    });
  });

  it.each([
    ['https://scontent-gru2-1.xx.fbcdn.net/v/t51/a.jpg'],
    ['https://scontent.cdninstagram.com/v/a.mp4'],
  ])('aceita subdomínio permitido %s', async (url) => {
    const http = transport(ok());

    await MetaMediaDownloader.withTransport(http).download(url);

    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['https://evil.example.com/a.jpg', 'host_not_allowed'],
    ['https://lookaside.fbsbx.com.evil.com/a.jpg', 'host_not_allowed'],
    ['https://fbcdn.net/a.jpg', 'host_not_allowed'],
    ['https://lookaside.instagram.com/a.jpg', 'host_not_allowed'],
    ['http://lookaside.fbsbx.com/a.jpg', 'not_https'],
    ['https://127.0.0.1/a.jpg', 'ip_literal'],
    ['https://[::1]/a.jpg', 'ip_literal'],
    ['https://lookaside.fbsbx.com:8443/a.jpg', 'invalid_url'],
    ['https://user:pw@lookaside.fbsbx.com/a.jpg', 'invalid_url'],
    ['nem-url', 'invalid_url'],
  ])('recusa %s (%s) sem tocar a rede', async (url, reason) => {
    const http = transport();

    const err = await MetaMediaDownloader.withTransport(http).download(url).catch((e) => e);

    expect(err).toBeInstanceOf(MediaDownloadError);
    expect(err.reason).toBe(reason);
    expect(err.retryable).toBe(false);
    expect(http).not.toHaveBeenCalled();
  });

  it('recusa redirecionamento para host fora da lista e não o segue', async () => {
    const http = transport(ok({ status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }));

    const err = await MetaMediaDownloader.withTransport(http).download(CDN_URL).catch((e) => e);

    expect(err.reason).toBe('redirect_refused');
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('segue redirecionamento só dentro da lista', async () => {
    const http = transport(
      ok({ status: 301, headers: { location: 'https://scontent.xx.fbcdn.net/b.jpg' } }),
      ok(),
    );

    const media = await MetaMediaDownloader.withTransport(http).download(CDN_URL);

    expect(media.host).toBe('scontent.xx.fbcdn.net');
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('para após 3 redirecionamentos', async () => {
    const hop = () => ok({ status: 302, headers: { location: 'https://scontent.xx.fbcdn.net/x.jpg' } });
    const http = transport(hop(), hop(), hop(), hop(), hop());

    const err = await MetaMediaDownloader.withTransport(http).download(CDN_URL).catch((e) => e);

    expect(err.reason).toBe('too_many_redirects');
    expect(http).toHaveBeenCalledTimes(4);
  });

  it.each([['text/html'], ['application/octet-stream'], ['']])(
    'recusa Content-Type %p',
    async (ct) => {
      const http = transport(ok({ headers: { 'content-type': ct } }));

      const err = await MetaMediaDownloader.withTransport(http).download(CDN_URL).catch((e) => e);

      expect(err.reason).toBe('content_type_not_allowed');
    },
  );

  it('recusa excesso de tamanho pelo cabeçalho e pelo corpo', async () => {
    const byHeader = transport(ok({ headers: { 'content-type': 'video/mp4', 'content-length': '11' } }));
    const byBody = transport(ok({ headers: { 'content-type': 'video/mp4' }, data: Buffer.alloc(11) }));

    const e1 = await MetaMediaDownloader.withTransport(byHeader, { maxBytes: 10 }).download(CDN_URL).catch((e) => e);
    const e2 = await MetaMediaDownloader.withTransport(byBody, { maxBytes: 10 }).download(CDN_URL).catch((e) => e);

    expect(e1.reason).toBe('too_large');
    expect(e2.reason).toBe('too_large');
  });

  it('classifica status: 404 desiste, 503 retenta; timeout retenta; IP privado desiste', async () => {
    const run = (r: MediaHttpResponse | Error) =>
      MetaMediaDownloader.withTransport(transport(r)).download(CDN_URL).catch((e) => e);
    const timeout = Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' });
    const priv = Object.assign(new Error('x'), { code: 'EPRIVATEADDR' });

    const [e404, e503, eTimeout, ePriv] = await Promise.all([
      run(ok({ status: 404 })),
      run(ok({ status: 503 })),
      run(timeout),
      run(priv),
    ]);

    expect([e404.reason, e404.status, e404.retryable]).toEqual(['http_status', 404, false]);
    expect([e503.reason, e503.retryable]).toEqual(['http_status', true]);
    expect([eTimeout.reason, eTimeout.retryable]).toEqual(['timeout', true]);
    expect([ePriv.reason, ePriv.retryable]).toEqual(['private_address', false]);
  });

  it('isPrivateAddress cobre privados, loopback, link-local e mapeados', () => {
    const blocked = ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'nao-ip'];
    const allowed = ['157.240.12.35', '31.13.85.8', '2a03:2880:f12f:83:face:b00c:0:25de'];

    expect(blocked.filter((a) => !isPrivateAddress(a))).toEqual([]);
    expect(allowed.filter((a) => isPrivateAddress(a))).toEqual([]);
  });

  it('safeLookup recusa quando o DNS resolve para IP privado e repassa quando é público', async () => {
    const lookup = jest.spyOn(dns, 'lookup') as unknown as jest.Mock;
    const resolveWith = (list: dns.LookupAddress[]) =>
      lookup.mockImplementationOnce((_h: string, _o: unknown, cb: any) => cb(null, list));
    const call = () =>
      new Promise<{ err: any; address: any }>((resolve) =>
        safeLookup('lookaside.fbsbx.com', {}, (err, address) => resolve({ err, address })),
      );

    resolveWith([{ address: '157.240.12.35', family: 4 }, { address: '10.0.0.7', family: 4 }]);
    const bad = await call();
    resolveWith([{ address: '157.240.12.35', family: 4 }]);
    const good = await call();

    expect(bad.err?.code).toBe('EPRIVATEADDR');
    expect(good.err).toBeNull();
    expect(good.address).toBe('157.240.12.35');
  });
});

// ─── serviço de espelhamento ───────────────────────────────────────────────

describe('InboundMediaMirrorService.runJob', () => {
  it('feliz (menção a story): baixa uma vez, salva com saveInboundMedia e troca os dois campos', async () => {
    const h = harness();

    const res = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });

    expect(res).toEqual({ status: 'mirrored', fields: ['media', 'story'] });
    expect(h.http).toHaveBeenCalledTimes(1);
    expect(h.uploads.saveInboundMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/jpeg', channelId: 'ch1' }),
    );
    const [media, story] = rawCalls(h.prisma);
    expect(media.values).toEqual([OURS, CDN_URL, 'msg-1', CDN_URL]);
    expect(story.values).toEqual([OURS, CDN_URL, 'msg-1', CDN_URL]);
  });

  it('atualização atômica: um UPDATE com jsonb_set/|| e guarda no WHERE, nunca ler-modificar-gravar', async () => {
    const h = harness();

    await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });

    const [media, story] = rawCalls(h.prisma);
    expect(media.sql).toContain(`UPDATE "messages" SET "content" = jsonb_set("content", '{mediaUrl}', to_jsonb(?::text))`);
    expect(media.sql).toContain(`"metadata" = (CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata" ELSE '{}'::jsonb END) || jsonb_build_object('originalMediaUrl', ?::text)`);
    expect(media.sql).toContain(`WHERE "id" = ? AND jsonb_typeof("content") = 'object' AND "content"->>'mediaUrl' = ?`);
    expect(story.sql).toContain(`jsonb_set("metadata", '{replyTo,story,url}', to_jsonb(?::text))`);
    expect(story.sql).toContain(`AND jsonb_typeof("metadata" #> '{replyTo,story}') = 'object' AND "metadata" #>> '{replyTo,story,url}' = ?`);
    expect(h.prisma.message.update).not.toHaveBeenCalled();
  });

  it('resposta a story: troca só metadata.replyTo.story.url', async () => {
    const h = harness({
      row: storyMention({ content: { text: 'amei' }, metadata: { replyTo: { story: { id: 's1', url: CDN_URL, kind: 'reply' } } } }),
    });

    const res = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });

    expect(res).toEqual({ status: 'mirrored', fields: ['story'] });
    expect(rawCalls(h.prisma)).toHaveLength(1);
    expect(rawCalls(h.prisma)[0].sql).toContain('{replyTo,story,url}');
  });

  it('falha de download mantém o link original e a mensagem; registra o motivo e desiste', async () => {
    const h = harness({ http: transport(ok({ status: 404 }), ok({ status: 404 })) });

    const err = await h.service
      .runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false })
      .catch((e) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe('http_status:404');
    expect(h.uploads.saveInboundMedia).not.toHaveBeenCalled();
    const calls = rawCalls(h.prisma);
    expect(h.http).toHaveBeenCalledTimes(1); // mesma URL nos dois campos: um download só
    expect(calls).toHaveLength(2); // uma desistência registrada por campo
    expect(calls[0].sql).toContain(`'{mediaMirror}'`);
    expect(calls[0].sql).toContain(`jsonb_build_object( 'status', 'failed'`);
    expect(calls.map((c: any) => c.values.slice(0, 3))).toEqual([
      ['media', 'http_status', 404],
      ['story', 'http_status', 404],
    ]);
    expect(calls[0].sql).not.toContain('"content" ='); // o registro não troca a mídia (só a compara)
    expect(h.prisma.message.update).not.toHaveBeenCalled();
    expect(h.prisma.message.delete).not.toHaveBeenCalled();
  });

  it('falha retentável: relança para o BullMQ sem registrar; na última tentativa registra e desiste', async () => {
    const h = harness({ http: transport(ok({ status: 503 }), ok({ status: 503 }), ok({ status: 503 }), ok({ status: 503 })) });

    const notFinal = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false }).catch((e) => e);
    const callsAfterRetry = rawCalls(h.prisma).length;
    const final = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: true }).catch((e) => e);

    expect(notFinal).not.toBeInstanceOf(UnrecoverableError);
    expect(notFinal.message).toBe('http_status:503');
    expect(callsAfterRetry).toBe(0);
    expect(final).toBeInstanceOf(UnrecoverableError);
    expect(rawCalls(h.prisma).map((c: any) => c.values[0])).toEqual(['media', 'story']);
  });

  it('idempotente: com a URL já nossa não faz nada; duas execuções = um download', async () => {
    const already = harness({
      row: storyMention({ content: { text: '[Story mention]', mediaUrl: OURS }, metadata: { replyTo: { story: { url: OURS } } } }),
    });
    const twice = harness();
    twice.prisma.$executeRaw.mockImplementation(async () => {
      twice.setRow(storyMention({ content: { text: '[Story mention]', mediaUrl: OURS }, metadata: { originalMediaUrl: CDN_URL, replyTo: { story: { url: OURS } } } }));
      return 1;
    });

    const noop = await already.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });
    const first = await twice.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });
    const second = await twice.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });

    expect(noop).toEqual({ status: 'noop' });
    expect(already.http).not.toHaveBeenCalled();
    expect(already.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(first.status).toBe('mirrored');
    expect(second).toEqual({ status: 'noop' });
    expect(twice.http).toHaveBeenCalledTimes(1);
  });

  it('host fora da lista nem vira alvo (não baixa, não grava)', async () => {
    const h = harness({ row: storyMention({ content: { mediaUrl: 'https://evil.example.com/a.jpg' }, metadata: {} }) });

    const res = await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });

    expect(res).toEqual({ status: 'noop' });
    expect(h.http).not.toHaveBeenCalled();
  });

  it('nenhum log nem erro contém a URL, a query ou o token', async () => {
    const happy = harness();
    const failing = harness({ http: transport(ok({ status: 404 }), ok({ status: 404 })) });
    const redirect = harness({ http: transport(ok({ status: 302, headers: { location: `https://evil.example.com/?${SECRET}` } }), ok({ status: 302, headers: { location: `https://evil.example.com/?${SECRET}` } })) });
    const crash = harness();
    (crash.uploads.saveInboundMedia as jest.Mock).mockRejectedValue(new Error(`S3 down for ${CDN_URL}`));

    const errors: unknown[] = [];
    await happy.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: false });
    for (const h of [failing, redirect, crash]) {
      errors.push(await h.service.runJob({ messageId: 'msg-1', channelId: 'ch1' }, { isFinalAttempt: true }).catch((e) => e));
    }
    await happy.service.enqueueForMessage(storyMention(), 'ch1');

    const everything = [...logged, ...errors.map((e) => String((e as Error).message))].join('\n');
    expect(logged.length).toBeGreaterThan(0);
    expect(everything).not.toContain('SIGNED_TOKEN_123');
    expect(everything).not.toContain('asset_id');
    expect(everything).not.toContain('ig_messaging_cdn');
    expect(everything).toContain('lookaside.fbsbx.com');
    expect(everything).toContain('msg-1');
  });
});

describe('InboundMediaMirrorService.enqueueForMessage', () => {
  it('enfileira só ids (sem URL), com jobId estável, 4 tentativas e recuo custom', async () => {
    const h = harness();

    const queued = await h.service.enqueueForMessage(storyMention(), 'ch1');

    expect(queued).toBe(true);
    expect(h.queue.add).toHaveBeenCalledWith(
      'mirror',
      { messageId: 'msg-1', channelId: 'ch1' },
      expect.objectContaining({ jobId: 'mirror-msg-1', attempts: MIRROR_JOB_ATTEMPTS, backoff: { type: 'custom' } }),
    );
    expect(JSON.stringify(h.queue.add.mock.calls)).not.toContain('SIGNED_TOKEN_123');
    expect(MIRROR_JOB_ATTEMPTS).toBe(4);
    expect([1, 2, 3].map(mirrorBackoffStrategy)).toEqual([30_000, 120_000, 600_000]);
    expect(INBOUND_MEDIA_MIRROR_QUEUE).toBe('inbound-media-mirror');
  });

  it('não enfileira enviada pelo BullQ (URL nossa), URL nossa, host fora da lista nem documento; fila quebrada não lança', async () => {
    const h = harness();
    const broken = harness();
    broken.queue.add.mockRejectedValue(new Error('redis down'));

    const results = await Promise.all([
      h.service.enqueueForMessage(storyMention({ direction: 'OUTBOUND', content: { mediaUrl: OURS }, metadata: {} }), 'ch1'),
      h.service.enqueueForMessage(storyMention({ content: { mediaUrl: OURS }, metadata: {} }), 'ch1'),
      h.service.enqueueForMessage(storyMention({ content: { mediaUrl: 'https://evil.example.com/a' }, metadata: {} }), 'ch1'),
      h.service.enqueueForMessage(storyMention({ type: 'DOCUMENT', metadata: {} }), 'ch1'),
      broken.service.enqueueForMessage(storyMention(), 'ch1'),
    ]);

    expect(results).toEqual([false, false, false, false, false]);
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

// ─── os dois caminhos de entrada ───────────────────────────────────────────

describe('Caminho webhook: mapper → InboundMessageProcessor → fila', () => {
  function processorWith(mirror: { enqueueForMessage: jest.Mock }) {
    const created: any[] = [];
    const prisma: any = {
      channel: { findUnique: jest.fn(async () => null) },
      contact: { findUnique: jest.fn(async () => ({ name: 'x', avatarUrl: 'y' })) },
      conversation: { findUnique: jest.fn(async () => ({ metadata: {} })), update: jest.fn() },
      message: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => {
          const m = { id: 'msg-1', ...data };
          created.push(m);
          return m;
        }),
      },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    const processor = new InboundMessageProcessor(
      prisma,
      { claimProcessing: jest.fn(async () => true), markProcessed: jest.fn(), releaseClaim: jest.fn() } as any,
      { resolve: jest.fn(async () => ({ contactId: 'contact', isNew: false })) } as any,
      { resolve: jest.fn(async () => ({ conversationId: 'conv', status: ConversationStatus.OPEN })) } as any,
      { messageNotificationState: jest.fn().mockResolvedValue({ mutedUntil: null, suppressNotifications: false }), emitToChannel: jest.fn(), emitToConversation: jest.fn() } as any,
      {} as any, {} as any, { markProcessed: jest.fn(), markFailed: jest.fn() } as any,
      {} as any, {} as any, {} as any,
      { enqueue: jest.fn() } as any,
      { scheduleCheck: jest.fn(async () => undefined), cancelCheck: jest.fn(async () => undefined) } as any,
      { add: jest.fn() } as any,
      mirror as any,
    );
    jest.spyOn(processor as any, 'tryAiAgent').mockResolvedValue(undefined);
    return { processor, created };
  }

  it('grava a mensagem primeiro e depois enfileira o espelhamento com a linha gravada', async () => {
    let createdWhenEnqueued = -1;
    const mirror = {
      enqueueForMessage: jest.fn(async () => {
        createdWhenEnqueued = ctx.created.length;
        return true;
      }),
    };
    const ctx = processorWith(mirror);
    const { processor, created } = ctx;
    const normalized = new InstagramMessageMapper().normalizeInbound({
      sender: { id: 'contact_ig' },
      recipient: { id: 'our_ig' },
      timestamp: 1762000000000,
      message: { mid: 'm_1', attachments: [{ type: 'story_mention', payload: { url: CDN_URL } }] },
    })!;
    const job: any = { name: 'process-inbound', data: { channelId: 'ch1', organizationId: 'org', message: normalized } };

    const res = await processor.process(job);

    expect(res).toMatchObject({ messageId: 'msg-1' });
    expect(created).toHaveLength(1);
    expect(createdWhenEnqueued).toBe(1);
    expect(mirror.enqueueForMessage).toHaveBeenCalledTimes(1);
    const [row, channelId] = mirror.enqueueForMessage.mock.calls[0] as any[];
    expect(channelId).toBe('ch1');
    expect(row.content.mediaUrl).toBe(CDN_URL);
    expect(row.metadata.replyTo.story.url).toBe(CDN_URL);
  });

  it.each([
    ['pendente para sempre', () => new Promise<boolean>(() => undefined)],
    ['que rejeita', () => Promise.reject(new Error('redis down'))],
  ])('enfileiramento %s não falha nem atrasa a mensagem', async (_label, impl) => {
    const mirror = { enqueueForMessage: jest.fn(impl) };
    const { processor } = processorWith(mirror);
    const job: any = {
      name: 'process-inbound',
      data: {
        channelId: 'ch1',
        organizationId: 'org',
        message: { externalMessageId: 'm_2', externalContactId: 'c', channelType: 'INSTAGRAM', type: 'IMAGE', content: { mediaUrl: CDN_URL } },
      },
    };

    const res = await processor.process(job);

    expect(res).toMatchObject({ messageId: 'msg-1' });
    expect(mirror.enqueueForMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Caminho importação: sync adapter → HistoryImportService → fila', () => {
  const BUSINESS = '17841448044331699';
  const igChannel = { id: 'ch1', type: 'INSTAGRAM' } as unknown as Channel;

  it('enfileira as recebidas recém-criadas com mídia do CDN da Meta (depois do commit)', async () => {
    const adapter = new InstagramSyncAdapter({
      resolveBusinessId: jest.fn(async () => BUSINESS),
      listConversationMessages: jest.fn(async () => ({
        data: [
          {
            id: 'm_hist_img',
            created_time: '2026-10-30T10:00:00.000Z',
            from: { id: 'contact_ig' },
            to: { data: [{ id: BUSINESS }] },
            attachments: { data: [{ mime_type: 'image/jpeg', image_data: { url: CDN_URL } }] },
          },
        ],
      })),
    } as unknown as InstagramHttpClient);
    const { messages } = await adapter.fetchMessages(igChannel, 'conv-ext', {}, undefined, 50);
    const h = harness({ row: { id: 'msg-9', direction: 'INBOUND', type: 'IMAGE', content: messages[0].content, metadata: {} } });
    const order: string[] = [];
    const tx: any = {
      conversation: { findUnique: jest.fn(async () => ({ metadata: {} })), updateMany: jest.fn() },
      message: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => { order.push('createMany'); return { count: 1 }; }) },
    };
    h.queue.add.mockImplementation(async () => { order.push('queue.add'); return {}; });
    const importer = new HistoryImportService({ $transaction: jest.fn((fn: any) => fn(tx)) } as any, {} as any, h.service);

    const res = await importer.importMessages(igChannel, 'conv', messages);
    await new Promise((r) => setImmediate(r)); // o enfileiramento roda solto, depois do commit

    expect(res).toEqual({ imported: 1, skipped: 0 });
    expect(h.prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId: 'conv', externalId: { in: ['m_hist_img'] } } }),
    );
    expect(h.queue.add).toHaveBeenCalledWith('mirror', { messageId: 'msg-9', channelId: 'ch1' }, expect.anything());
    expect(order).toEqual(['createMany', 'queue.add']);
  });

  it('não enfileira para canal que não é Instagram', async () => {
    const h = harness();
    const tx: any = {
      conversation: { findUnique: jest.fn(async () => ({ metadata: {} })), updateMany: jest.fn() },
      message: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => ({ count: 1 })) },
    };
    const importer = new HistoryImportService({ $transaction: jest.fn((fn: any) => fn(tx)) } as any, {} as any, h.service);

    await importer.importMessages({ id: 'ch2', type: 'WHATSAPP_OFFICIAL' } as unknown as Channel, 'conv', [
      { externalMessageId: 'w1', externalConversationId: 'c', externalContactId: 'x', direction: 'INBOUND', timestamp: new Date('2026-10-30T10:00:00Z'), type: 'IMAGE', content: { mediaUrl: CDN_URL } } as any,
    ]);

    expect(h.prisma.message.findMany).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});
