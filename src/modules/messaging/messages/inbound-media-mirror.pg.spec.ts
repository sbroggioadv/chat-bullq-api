import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Client } from 'pg';
import { InboundMediaMirrorService } from './inbound-media-mirror.service';
import { MetaMediaDownloader, MediaHttpResponse } from './meta-media-downloader';
import { UploadsService } from './uploads.service';

/**
 * SPEC-017 — roda os UPDATEs do espelhamento (o SQL exato do serviço, via
 * Prisma.sql) contra um Postgres REAL. Opt-in: só roda com MIRROR_PG_URL
 * apontando para um banco descartável (ex.: contêiner postgres:16 local).
 * Sem a variável, a suíte aparece como "skipped" — nunca toca outro banco.
 *
 * Simula a corrida do compare-and-set: o worker lê um retrato "velho" da
 * mensagem (com URL da Meta), mas a linha no banco tem outro formato (chave
 * ausente, replyTo não-objeto, JSON escalar, JSON null). O UPDATE não pode
 * falhar nem deixar `metadata` fora do formato objeto.
 */

const PG_URL = process.env.MIRROR_PG_URL;
const suite = PG_URL ? describe : describe.skip;

const CDN = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&oh=TOKEN';
const CDN_404 = 'https://scontent.xx.fbcdn.net/gone.jpg';
const OURS = 'https://api.bullq.test/api/v1/uploads/inbound/ch1/2026-11-02/abc.jpg';

const okImage = async (url: string): Promise<MediaHttpResponse> =>
  url === CDN_404
    ? { status: 404, headers: {}, data: Buffer.alloc(0) }
    : { status: 200, headers: { 'content-type': 'image/jpeg' }, data: Buffer.from([1, 2, 3]) };

async function connectWithRetry(url: string, attempts = 40): Promise<Client> {
  for (let i = 0; ; i++) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => undefined);
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

suite('Espelhamento — SQL em Postgres real', () => {
  jest.setTimeout(60_000);
  let pg: Client;

  /** Linha no banco (estado real) + retrato que o worker "leu" antes. */
  async function seed(
    id: string,
    dbContent: string,
    dbMetadata: string,
    convMetadata = '{}',
  ): Promise<void> {
    await pg.query(`INSERT INTO "conversations" ("id", "metadata") VALUES ($1, $2::jsonb)`, [
      `conv-${id}`,
      convMetadata,
    ]);
    await pg.query(
      `INSERT INTO "messages" ("id", "conversation_id", "content", "metadata") VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
      [id, `conv-${id}`, dbContent, dbMetadata],
    );
  }

  async function read(id: string) {
    const { rows } = await pg.query(
      `SELECT "content", "metadata", jsonb_typeof("content") AS ct, jsonb_typeof("metadata") AS mt FROM "messages" WHERE "id" = $1`,
      [id],
    );
    return rows[0];
  }

  /** Serviço real com prisma fino: $executeRaw vai para o Postgres com o SQL exato. */
  function serviceReading(snapshot: Record<string, any>) {
    const executed: Array<{ text: string; rowCount: number | null }> = [];
    const prisma: any = {
      message: { findUnique: jest.fn(async () => snapshot) },
      conversation: { findUnique: jest.fn(async () => snapshot.conversation ?? { metadata: {} }) },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const q = Prisma.sql(strings, ...values);
        const res = await pg.query(q.text, q.values as any[]);
        executed.push({ text: q.text, rowCount: res.rowCount });
        return res.rowCount ?? 0;
      },
    };
    const deleteInboundMedia = jest.fn(async () => true);
    const uploads = {
      saveInboundMedia: async () => ({ url: OURS, mimeType: 'image/jpeg', size: 3, filename: 'abc.jpg' }),
      deleteInboundMedia,
    } as unknown as UploadsService;
    const service = new InboundMediaMirrorService(
      prisma,
      uploads,
      MetaMediaDownloader.withTransport(okImage),
      { add: jest.fn() } as any,
    );
    return { service, executed, deleteInboundMedia };
  }

  const snapshot = (id: string, over: Record<string, any> = {}) => ({
    id,
    direction: 'INBOUND',
    type: 'TEXT',
    conversationId: `conv-${id}`,
    content: { text: '[Story mention]', mediaUrl: CDN },
    metadata: { replyTo: { story: { url: CDN, kind: 'mention' } } },
    conversation: { metadata: {} },
    ...over,
  });

  const run = (service: InboundMediaMirrorService, id: string, final = false) =>
    service.runJob({ messageId: id, channelId: 'ch1' }, { isFinalAttempt: final }).catch((e) => e);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    pg = await connectWithRetry(PG_URL!);
    const { rows } = await pg.query('SHOW server_version');
    // eslint-disable-next-line no-console
    console.log(`MIRROR_PG server_version=${rows[0].server_version}`);
    await pg.query('DROP TABLE IF EXISTS "messages"; DROP TABLE IF EXISTS "conversations";');
    await pg.query(
      `CREATE TABLE "conversations" ("id" text PRIMARY KEY, "metadata" jsonb NOT NULL DEFAULT '{}');
       CREATE TABLE "messages" ("id" text PRIMARY KEY, "conversation_id" text NOT NULL,
         "content" jsonb NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}');`,
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await pg?.end();
  });

  it('caso normal: troca content.mediaUrl e replyTo.story.url e guarda os originais', async () => {
    await seed('normal', JSON.stringify(snapshot('x').content), JSON.stringify(snapshot('x').metadata));
    const { service } = serviceReading(snapshot('normal'));

    const res = await run(service, 'normal');
    const row = await read('normal');

    expect(res).toEqual({ status: 'mirrored', fields: ['media', 'story'] });
    expect(row.content).toEqual({ text: '[Story mention]', mediaUrl: OURS });
    expect(row.metadata).toEqual({
      originalMediaUrl: CDN,
      replyTo: { story: { url: OURS, kind: 'mention', originalUrl: CDN } },
    });
  });

  it.each([
    ['content sem a chave mediaUrl', '{"text":"oi"}', '{}'],
    ['metadata sem replyTo', '{"text":"oi"}', '{"isEcho":false}'],
    ['replyTo não-objeto', '{"text":"oi"}', '{"replyTo":"texto"}'],
    ['story não-objeto', '{"text":"oi"}', '{"replyTo":{"story":7}}'],
    ['content JSON escalar', '"texto"', '{}'],
    ['content JSON null', 'null', '{}'],
    ['metadata JSON escalar', '{"text":"oi"}', '5'],
    ['metadata JSON null', '{"text":"oi"}', 'null'],
  ])('linha divergente (%s): UPDATE não falha e não corrompe', async (label, content, metadata) => {
    const id = `div-${label.replace(/\W+/g, '-')}`;
    await seed(id, content, metadata);
    const before = await read(id);
    const { service, executed } = serviceReading(snapshot(id));

    const res = await run(service, id);
    const after = await read(id);

    expect(res).toEqual({ status: 'conflict', conflicts: ['media', 'story'] });
    expect(executed.every((e) => e.rowCount === 0)).toBe(true);
    expect(after.content).toEqual(before.content);
    expect(after.metadata).toEqual(before.metadata);
  });

  it.each([
    ['metadata JSON null', 'null'],
    ['metadata JSON escalar', '5'],
    ['metadata array', '[1,2]'],
  ])('mediaUrl ainda casa mas %s: metadata vira objeto, nunca array', async (label, metadata) => {
    const id = `meta-${label.replace(/\W+/g, '-')}`;
    await seed(id, JSON.stringify({ mediaUrl: CDN }), metadata);
    const { service } = serviceReading(snapshot(id, { content: { mediaUrl: CDN }, metadata: {} }));

    await run(service, id);
    const after = await read(id);

    expect(after.content).toEqual({ mediaUrl: OURS });
    expect(after.mt).toBe('object');
    expect(after.metadata).toEqual({ originalMediaUrl: CDN });
  });

  it.each([
    ['metadata objeto comum', '{"isEcho":false}'],
    ['metadata JSON null', 'null'],
    ['metadata JSON escalar', '"x"'],
  ])('registro de falha com %s: metadata fica objeto', async (label, metadata) => {
    const id = `fail-${label.replace(/\W+/g, '-')}`;
    await seed(id, JSON.stringify({ mediaUrl: CDN_404 }), metadata);
    const { service } = serviceReading(snapshot(id, { content: { mediaUrl: CDN_404 }, metadata: {} }));

    const err = await run(service, id);
    const after = await read(id);

    expect(err?.message).toBe('http_status:404');
    expect(after.mt).toBe('object');
    expect(after.content).toEqual({ mediaUrl: CDN_404 });
    expect(JSON.stringify(after.metadata)).toContain('"http_status"');
  });

  it('corrida com a limpeza: conversa fundida depois da leitura não recebe nenhuma escrita', async () => {
    // O worker leu a conversa ainda sem a marca; no banco ela já foi fundida.
    await seed('merged-race', JSON.stringify(snapshot('x').content), JSON.stringify(snapshot('x').metadata), '{"cleanup_merged_into":"conv-original"}');
    await seed('merged-race-404', JSON.stringify({ mediaUrl: CDN_404 }), '{}', '{"cleanup_merged_into":"conv-original"}');
    const before = await read('merged-race');
    const { service, executed } = serviceReading(snapshot('merged-race'));
    const failing = serviceReading(snapshot('merged-race-404', { content: { mediaUrl: CDN_404 }, metadata: {} }));

    await run(service, 'merged-race');
    await run(failing.service, 'merged-race-404', true);

    expect(executed.map((e) => e.rowCount)).toEqual([0, 0]);
    expect(failing.executed.map((e) => e.rowCount)).toEqual([0]);
    expect(await read('merged-race')).toMatchObject({ content: before.content, metadata: before.metadata });
    expect((await read('merged-race-404')).metadata).toEqual({});
  });

  it('conversa arquivada pelo usuário (sem a marca) recebe a escrita normalmente', async () => {
    await seed('archived', JSON.stringify({ mediaUrl: CDN }), '{}', '{"archivedBy":"user-1"}');
    const { service, executed } = serviceReading(snapshot('archived', { content: { mediaUrl: CDN }, metadata: {} }));

    await run(service, 'archived');

    expect(executed.map((e) => e.rowCount)).toEqual([1]);
    expect((await read('archived')).content).toEqual({ mediaUrl: OURS });
  });

  describe('Rodada 3 (B): 0 linhas não é sucesso', () => {
    it('conversa fundida no banco: resultado conflict, nada escrito, arquivo salvo apagado', async () => {
      await seed('b-merged', JSON.stringify({ mediaUrl: CDN }), '{}', '{"cleanup_merged_into":"conv-original"}');
      const { service, executed, deleteInboundMedia } = serviceReading(snapshot('b-merged', { content: { mediaUrl: CDN }, metadata: {} }));

      const res = await run(service, 'b-merged');

      expect(res).toEqual({ status: 'conflict', conflicts: ['media'] });
      expect(executed.map((e) => e.rowCount)).toEqual([0]);
      expect(deleteInboundMedia).toHaveBeenCalledWith(OURS);
      expect((await read('b-merged')).content).toEqual({ mediaUrl: CDN });
    });

    it('URL trocada no banco (a antiga baixou bem): resultado conflict e arquivo salvo apagado', async () => {
      const CDN_OTHER = 'https://scontent.cdninstagram.com/v/other.jpg';
      await seed('b-url', JSON.stringify({ mediaUrl: CDN_OTHER }), '{}');
      const { service, executed, deleteInboundMedia } = serviceReading(snapshot('b-url', { content: { mediaUrl: CDN }, metadata: {} }));

      const res = await run(service, 'b-url');

      expect(res).toEqual({ status: 'conflict', conflicts: ['media'] });
      expect(executed.map((e) => e.rowCount)).toEqual([0]);
      expect(deleteInboundMedia).toHaveBeenCalledWith(OURS);
      expect((await read('b-url')).content).toEqual({ mediaUrl: CDN_OTHER });
    });
  });

  describe('Rodada 3 (A): falha antiga não bloqueia URL nova', () => {
    const ref = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 16);

    it('(i) URL trocou durante o download: o 404 da URL antiga não marca a nova', async () => {
      // No banco a mídia já é outra URL; o worker leu a antiga (que dá 404).
      await seed('url-changed', JSON.stringify({ mediaUrl: CDN }), '{}');
      const { service, executed } = serviceReading(snapshot('url-changed', { content: { mediaUrl: CDN_404 }, metadata: {} }));

      const err = await run(service, 'url-changed');
      const after = await read('url-changed');

      expect(err?.message).toBe('http_status:404');
      expect(executed.map((e) => e.rowCount)).toEqual([0]);
      expect(after.metadata).toEqual({});
      expect(after.content).toEqual({ mediaUrl: CDN });
    });

    it('(ii) falha registrada de outra URL: o job novo tenta e espelha a URL atual', async () => {
      const metadata = { mediaMirror: { media: { status: 'failed', reason: 'http_status', httpStatus: 404, urlRef: ref(CDN_404) } } };
      await seed('url-new', JSON.stringify({ mediaUrl: CDN }), JSON.stringify(metadata));
      const { service } = serviceReading(snapshot('url-new', { content: { mediaUrl: CDN }, metadata }));

      await run(service, 'url-new');
      const after = await read('url-new');

      expect(after.content).toEqual({ mediaUrl: OURS });
      expect(after.metadata.originalMediaUrl).toBe(CDN);
    });

    it('(iii) falha registrada da mesma URL: o job não tenta nem escreve', async () => {
      const metadata = { mediaMirror: { media: { status: 'failed', reason: 'http_status', httpStatus: 404, urlRef: ref(CDN) } } };
      await seed('url-same', JSON.stringify({ mediaUrl: CDN }), JSON.stringify(metadata));
      const { service, executed } = serviceReading(snapshot('url-same', { content: { mediaUrl: CDN }, metadata }));

      const res = await run(service, 'url-same');

      expect(res).toEqual({ status: 'noop' });
      expect(executed).toEqual([]);
      expect((await read('url-same')).content).toEqual({ mediaUrl: CDN });
    });

    it('a falha gravada traz urlRef da URL que falhou e nunca a URL', async () => {
      await seed('url-ref', JSON.stringify({ mediaUrl: CDN_404 }), '{}');
      const { service } = serviceReading(snapshot('url-ref', { content: { mediaUrl: CDN_404 }, metadata: {} }));

      await run(service, 'url-ref');
      const after = await read('url-ref');

      expect(after.metadata.mediaMirror.media.urlRef).toBe(ref(CDN_404));
      expect(JSON.stringify(after.metadata.mediaMirror)).not.toContain('fbcdn');
    });
  });

  it('registro por campo preserva o registro do outro campo e o resto do metadata', async () => {
    const prior = { isEcho: false, mediaMirror: { story: { status: 'failed', reason: 'http_status', httpStatus: 404 } } };
    await seed('per-field', JSON.stringify({ mediaUrl: CDN_404 }), JSON.stringify(prior));
    const { service } = serviceReading(snapshot('per-field', { content: { mediaUrl: CDN_404 }, metadata: prior }));

    await run(service, 'per-field');
    const after = await read('per-field');

    expect(after.metadata.isEcho).toBe(false);
    expect(after.metadata.mediaMirror.story).toEqual(prior.mediaMirror.story);
    expect(after.metadata.mediaMirror.media).toMatchObject({ status: 'failed', reason: 'http_status', httpStatus: 404 });
  });
});
