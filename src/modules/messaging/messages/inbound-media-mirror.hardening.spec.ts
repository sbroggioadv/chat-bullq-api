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
