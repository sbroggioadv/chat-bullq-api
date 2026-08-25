import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  buildHarness,
  convA,
  emptyWorkbenchStore,
  expectHttp,
  mutationCalls,
  projectA,
  projectTask,
  workbenchEnv,
} from './clickup-inbox.test-harness';
import { MemoryW2Store, W3_LOCK_TTL_MS } from './clickup-inbox-w2.store';
import { HISTORICO_PREFIX, MAX_ATTACHMENT_BYTES } from './domain/incorporacao';

const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';

function boundGroup(overrides: Record<string, unknown> = {}) {
  return convA({
    isGroup: true,
    clickupTaskId: 'task-hold',
    contact: { name: 'Grupo Holding', phone: null },
    ...overrides,
  });
}

function textMessage(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversationId: 'conv-a',
    type: 'TEXT',
    direction: 'INBOUND',
    senderName: 'Maria',
    content: { text },
    revokedAt: null,
    createdAt: new Date('2026-08-25T21:00:00.000Z'),
    providerTimestamp: new Date('2026-08-25T21:00:00.000Z'),
    ...extra,
  };
}

function fileMessage(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversationId: 'conv-a',
    type: 'DOCUMENT',
    direction: 'INBOUND',
    senderName: 'Maria',
    content: {
      url: 'https://files.test/contrato.pdf',
      mimeType: 'application/pdf',
      fileName: 'contrato.pdf',
    },
    revokedAt: null,
    createdAt: new Date('2026-08-25T21:00:00.000Z'),
    ...extra,
  };
}

function w3Harness(opts: {
  conv?: any;
  project?: any | null;
  messages?: any[];
  attachments?: any[];
  store?: ReturnType<typeof emptyWorkbenchStore>;
  w2Store?: MemoryW2Store;
  storage?: any;
  env?: Record<string, string>;
} = {}) {
  const conv = opts.conv ?? boundGroup();
  const project = opts.project === undefined ? null : opts.project;
  const store = opts.store ?? emptyWorkbenchStore([projectTask('task-hold', 'list-holding')]);
  store.media = store.media ?? {
    'https://files.test/contrato.pdf': {
      bytes: Buffer.from('%PDF-1.4 test'),
      mime: 'application/pdf',
    },
  };
  return {
    conv,
    project,
    ...buildHarness({
      env: opts.env ?? workbenchEnv(),
      conv,
      conversations: [conv],
      projects: project ? [project] : [],
      links: project ? [{ conversationId: conv.id, projectId: project.id }] : [],
      messages: opts.messages ?? [textMessage('msg-1', 'contrato assinado'), fileMessage('msg-file')],
      attachments: opts.attachments ?? [],
      store,
      w2Store: opts.w2Store,
      storage: opts.storage,
    }),
  };
}

function commentPosts(fetchFn: { mock: { calls: any[] } }) {
  return fetchFn.mock.calls.filter(
    (c: any) => /\/task\/[^/]+\/comment$/.test(String(c[0])) && (c[1]?.method ?? 'GET') === 'POST',
  );
}

function attachmentPosts(fetchFn: { mock: { calls: any[] } }) {
  return fetchFn.mock.calls.filter(
    (c: any) => /\/task\/[^/]+\/attachment$/.test(String(c[0])) && (c[1]?.method ?? 'GET') === 'POST',
  );
}

describe('SPEC-009 W3 incorporations', () => {
  it('AC-16 XOR: um request com os dois origins é 422; comment e attachment são POSTs independentes', async () => {
    const { service, fetchFn } = w3Harness();
    await expectHttp(
      service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'comment',
        messageId: 'msg-1',
        documentId: 'doc-1',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(commentPosts(fetchFn).length).toBe(0);

    const comment = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'comment',
      messageId: 'msg-1',
    });
    expect(comment.kind).toBe('comment');
    expect(commentPosts(fetchFn).length).toBe(1);
    const posted = JSON.parse(String(commentPosts(fetchFn)[0][1].body));
    expect(posted.notify_all).toBe(false);
    expect(posted.comment_text).toContain(HISTORICO_PREFIX);
    expect(posted.comment_text).toContain('Maria: contrato assinado');

    const att = await service.incorporateWorkbench('org-a', 'conv-a', KEY_B, {
      kind: 'attachment',
      messageId: 'msg-file',
    });
    expect(att.kind).toBe('attachment');
    expect(attachmentPosts(fetchFn).length).toBe(1);
  });

  it('AC-16b bound sem dossiê sobe o arquivo; não exige Project', async () => {
    const { service, fetchFn, prisma } = w3Harness({ project: null });
    const out = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'attachment',
      messageId: 'msg-file',
    });
    expect(out.ok).toBe(true);
    expect(attachmentPosts(fetchFn).length).toBe(1);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('AC-17 origem cruzada, unbound e body adulterado fazem zero escrita', async () => {
    const { service, fetchFn } = w3Harness({
      messages: [textMessage('msg-other', 'segredo', { conversationId: 'conv-other' })],
    });
    await expectHttp(
      service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'comment',
        messageId: 'msg-other',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );

    const unbound = w3Harness({ conv: boundGroup({ clickupTaskId: null }) });
    await expectHttp(
      unbound.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'comment',
        messageId: 'msg-1',
      }),
      404,
      'CLICKUP_TASK_NOT_BOUND',
    );

    await expectHttp(
      service.incorporateWorkbench('org-a', 'conv-a', KEY_B, {
        kind: 'attachment',
        documentId: 'doc-forjado',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(commentPosts(fetchFn).length).toBe(0);
    expect(attachmentPosts(unbound.fetchFn).length).toBe(0);
  });

  it('AC-18 retry da mesma key não duplica; kinds têm receipts separados', async () => {
    const { service, fetchFn } = w3Harness();
    const first = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'comment',
      messageId: 'msg-1',
    });
    const retry = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'comment',
      messageId: 'msg-1',
    });
    expect(retry.id).toBe(first.id);
    expect(commentPosts(fetchFn).length).toBe(1);

    const att = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'attachment',
      messageId: 'msg-file',
    });
    expect(att.kind).toBe('attachment');
    expect(att.id).not.toBe(first.id);
    expect(attachmentPosts(fetchFn).length).toBe(1);
  });

  it('AC-18 falha não finaliza receipt; retry da mesma key pode reenviar', async () => {
    const store = emptyWorkbenchStore([projectTask('task-hold', 'list-holding')]);
    store.failConfirmAttachment = true;
    store.media = {
      'https://files.test/contrato.pdf': { bytes: Buffer.from('%PDF-1.4'), mime: 'application/pdf' },
    };
    const { service, fetchFn, w2Store } = w3Harness({ store });
    await expect(
      service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-file',
      }),
    ).rejects.toBeTruthy();
    expect(await w2Store.getReceipt('org-a', 'conv:conv-a:w3:attachment:msg-file', KEY_A)).not.toEqual(
      expect.objectContaining({ state: 'done' }),
    );
    store.failConfirmAttachment = false;
    const retry = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'attachment',
      messageId: 'msg-file',
    });
    expect(retry.ok).toBe(true);
    expect(attachmentPosts(fetchFn).length).toBe(2);
  });

  it('AC-19 Redis down falha antes do POST; 5xx não expõe body; 25MiB+1 é 422', async () => {
    const down = w3Harness({ w2Store: new MemoryW2Store({ failReady: true }) });
    await expectHttp(
      down.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'comment',
        messageId: 'msg-1',
      }),
      503,
      'CLICKUP_STORE_UNAVAILABLE',
    );
    expect(commentPosts(down.fetchFn).length).toBe(0);

    const boom = w3Harness();
    boom.store.statusCode = 500;
    await expectHttp(
      boom.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'comment',
        messageId: 'msg-1',
      }),
      502,
      'CLICKUP_UPSTREAM',
    );

    const big = w3Harness({
      messages: [
        fileMessage('msg-big', { content: { url: 'https://files.test/contrato.pdf', mimeType: 'application/pdf', fileName: 'contrato.pdf', size: MAX_ATTACHMENT_BYTES + 1 } }),
      ],
    });
    await expectHttp(
      big.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-big',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(attachmentPosts(big.fetchFn).length).toBe(0);
  });

  it('AC-17 MIME deny e comment em áudio sem caption fazem zero POST', async () => {
    const { service, fetchFn } = w3Harness({
      messages: [
        fileMessage('msg-exe', {
          content: {
            url: 'https://files.test/contrato.pdf',
            mimeType: 'application/x-msdownload',
            fileName: 'x.exe',
          },
        }),
        textMessage('msg-audio', '', { type: 'AUDIO', content: {} }),
      ],
    });
    await expectHttp(
      service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-exe',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    await expectHttp(
      service.incorporateWorkbench('org-a', 'conv-a', KEY_B, {
        kind: 'comment',
        messageId: 'msg-audio',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(mutationCalls(fetchFn).length).toBe(0);
  });

  it('documento do dossiê ligado anexa; documento de outro dossiê 422', async () => {
    const project = projectA();
    const { service, fetchFn } = w3Harness({
      project,
      attachments: [
        {
          id: 'doc-1',
          projectId: 'proj-a',
          url: 'https://files.test/contrato.pdf',
          fileName: 'contrato.pdf',
          mimeType: 'application/pdf',
          label: 'Contrato',
        },
      ],
    });
    const out = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'attachment',
      documentId: 'doc-1',
    });
    expect(out.kind).toBe('attachment');
    expect(attachmentPosts(fetchFn).length).toBe(1);

    const other = w3Harness({
      project: projectA({ id: 'proj-b' }),
      attachments: [
        {
          id: 'doc-x',
          projectId: 'proj-x',
          url: 'https://files.test/contrato.pdf',
          fileName: 'x.pdf',
          mimeType: 'application/pdf',
          label: 'X',
        },
      ],
    });
    await expectHttp(
      other.service.incorporateWorkbench('org-a', 'conv-a', KEY_B, {
        kind: 'attachment',
        documentId: 'doc-x',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
  });

  const uploadsUrl = '/api/v1/uploads/documents/2026-08-25/file.pdf';

  it('F-01 local presente lê o arquivo; S3 cobre local ausente; faltando nos dois é 422', async () => {
    const root = join(process.cwd(), 'uploads-w3-test');
    const prev = process.env.UPLOADS_DIR;
    process.env.UPLOADS_DIR = root;
    const rel = 'documents/2026-08-25/file.pdf';
    mkdirSync(join(root, 'documents/2026-08-25'), { recursive: true });
    writeFileSync(join(root, rel), '%PDF-local');
    try {
      const local = w3Harness({
        messages: [fileMessage('msg-up', { content: { url: uploadsUrl, mimeType: 'application/pdf', fileName: 'file.pdf' } })],
      });
      const out = await local.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-up',
      });
      expect(out.ok).toBe(true);
      expect(attachmentPosts(local.fetchFn).length).toBe(1);
      expect(local.mediaFetch).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (prev === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prev;
    }

    const getObject = jest.fn(async () => Readable.from([Buffer.from('%PDF-s3')]));
    const s3 = w3Harness({
      messages: [fileMessage('msg-up', { content: { url: uploadsUrl, mimeType: 'application/pdf', fileName: 'file.pdf' } })],
      storage: {
        isReady: () => true,
        getBucket: () => 'bullq',
        getClient: () => ({ getObject }),
      },
    });
    const s3Out = await s3.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'attachment',
      messageId: 'msg-up',
    });
    expect(s3Out.ok).toBe(true);
    expect(getObject).toHaveBeenCalledWith('bullq', 'documents/2026-08-25/file.pdf');
    expect(attachmentPosts(s3.fetchFn).length).toBe(1);

    const missing = w3Harness({
      project: projectA(),
      messages: [fileMessage('msg-up', { content: { url: uploadsUrl, mimeType: 'application/pdf', fileName: 'file.pdf' } })],
    });
    await expectHttp(
      missing.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-up',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(missing.mediaFetch).toHaveBeenCalled();
    expect(attachmentPosts(missing.fetchFn).length).toBe(0);

    const clip = w3Harness({
      project: null,
      messages: [fileMessage('msg-up', { content: { url: uploadsUrl, mimeType: 'application/pdf', fileName: 'file.pdf' } })],
      storage: {
        isReady: () => true,
        getBucket: () => 'bullq',
        getClient: () => ({ getObject: async () => Readable.from([Buffer.from('%PDF-clip')]) }),
      },
    });
    const clipOut = await clip.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'attachment',
      messageId: 'msg-up',
    });
    expect(clipOut.ok).toBe(true);
    expect(attachmentPosts(clip.fetchFn).length).toBe(1);
  });

  it('F-02 declaração image/png e bytes MZ/x-msdownload fazem zero POST', async () => {
    const mz = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    const store = emptyWorkbenchStore([projectTask('task-hold', 'list-holding')]);
    store.media = {
      'https://files.test/spoofed.png': { bytes: mz, mime: 'application/x-msdownload' },
    };
    const { service, fetchFn } = w3Harness({
      store,
      messages: [
        fileMessage('msg-spoof', {
          content: {
            url: 'https://files.test/spoofed.png',
            mimeType: 'image/png',
            fileName: 'spoofed.png',
          },
        }),
      ],
    });
    await expectHttp(
      service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-spoof',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(attachmentPosts(fetchFn).length).toBe(0);
  });

  it('F-03 não recupera por filename homônimo; lock cobre o pior caso', async () => {
    expect(W3_LOCK_TTL_MS).toBeGreaterThanOrEqual(150_000);
    const store = emptyWorkbenchStore([
      projectTask('task-hold', 'list-holding', {
        attachments: [{ id: 'att-old', title: 'contrato.pdf', size: 99 }],
      }),
    ]);
    store.media = {
      'https://files.test/contrato.pdf': { bytes: Buffer.from('%PDF-new-bytes'), mime: 'application/pdf' },
    };
    const { service, fetchFn } = w3Harness({ store });
    const created = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'attachment',
      messageId: 'msg-file',
    });
    expect(created.id).not.toBe('att-old');
    expect(attachmentPosts(fetchFn).length).toBe(1);

    const again = await service.incorporateWorkbench('org-a', 'conv-a', KEY_B, {
      kind: 'attachment',
      messageId: 'msg-file',
    });
    expect(again.id).toBe(created.id);
    expect(attachmentPosts(fetchFn).length).toBe(1);
  });

  it('host arbitrário com /api/v1/uploads/ é 422 e zero fetch', async () => {
    const evil = 'https://evil.example/api/v1/uploads/documents/2026-08-25/file.pdf';
    const { service, fetchFn, mediaFetch } = w3Harness({
      messages: [
        fileMessage('msg-ssrf', {
          content: { url: evil, mimeType: 'application/pdf', fileName: 'file.pdf' },
        }),
      ],
    });
    await expectHttp(
      service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-ssrf',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(attachmentPosts(fetchFn).length).toBe(0);

    const query = w3Harness({
      messages: [
        fileMessage('msg-ssrf-q', {
          content: {
            url: 'https://evil.example/cdn?next=/api/v1/uploads/x',
            mimeType: 'application/pdf',
            fileName: 'file.pdf',
          },
        }),
      ],
    });
    await expectHttp(
      query.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-ssrf-q',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(query.mediaFetch).not.toHaveBeenCalled();
    expect(attachmentPosts(query.fetchFn).length).toBe(0);
  });

  it('mesmo origin de APP_URL com /api/v1/uploads/ pode ler internamente', async () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = 'https://bullq.test';
    const url = 'https://bullq.test/api/v1/uploads/documents/2026-08-25/ok.pdf';
    try {
      const store = emptyWorkbenchStore([projectTask('task-hold', 'list-holding')]);
      store.media = { [url]: { bytes: Buffer.from('%PDF-same-origin'), mime: 'application/pdf' } };
      const { service, fetchFn, mediaFetch } = w3Harness({
        store,
        messages: [
          fileMessage('msg-origin', {
            content: { url, mimeType: 'application/pdf', fileName: 'ok.pdf' },
          }),
        ],
      });
      const out = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-origin',
      });
      expect(out.ok).toBe(true);
      expect(mediaFetch).toHaveBeenCalled();
      expect(attachmentPosts(fetchFn).length).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prev;
    }
  });

  it('F-03 marker exato: prefixo de originId e size ausente não recuperam', async () => {
    const bytes = Buffer.from('%PDF-new-bytes');
    const store = emptyWorkbenchStore([
      projectTask('task-hold', 'list-holding', {
        attachments: [
          { id: 'att-prefix', title: 'contrato.bqx-msg.pdf', size: bytes.byteLength },
          { id: 'att-nosize', title: 'contrato.bqx-msg-file.pdf' },
        ],
      }),
    ]);
    store.media = {
      'https://files.test/contrato.pdf': { bytes, mime: 'application/pdf' },
    };
    const { service, fetchFn } = w3Harness({ store });
    const created = await service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'attachment',
      messageId: 'msg-file',
    });
    expect(created.id).not.toBe('att-prefix');
    expect(created.id).not.toBe('att-nosize');
    expect(attachmentPosts(fetchFn).length).toBe(1);
  });

  it('AC-19 matriz 401/403/404/409/429/5xx/timeout/config e cap exato 25 MiB', async () => {
    for (const status of [401, 403, 404, 409, 429, 500]) {
      const row = w3Harness();
      row.store.statusCode = status;
      await expect(row.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'comment',
        messageId: 'msg-1',
      })).rejects.toBeTruthy();
      expect(commentPosts(row.fetchFn).length).toBe(0);
    }

    const timed = w3Harness();
    timed.store.abort = true;
    await expectHttp(
      timed.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'comment',
        messageId: 'msg-1',
      }),
      504,
      'CLICKUP_TIMEOUT',
    );

    const env = workbenchEnv();
    env.CLICKUP_API_KEY = '';
    const bare = w3Harness({ env });
    await expectHttp(
      bare.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'comment',
        messageId: 'msg-1',
      }),
      503,
      'CLICKUP_NOT_CONFIGURED',
    );

    const exact = Buffer.alloc(MAX_ATTACHMENT_BYTES, 1);
    const cap = w3Harness({
      messages: [fileMessage('msg-exact', { content: { url: 'https://files.test/exact.pdf', mimeType: 'application/pdf', fileName: 'exact.pdf' } })],
    });
    cap.store.media = { 'https://files.test/exact.pdf': { bytes: exact, mime: 'application/pdf' } };
    const ok = await cap.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
      kind: 'attachment',
      messageId: 'msg-exact',
    });
    expect(ok.ok).toBe(true);
    expect(attachmentPosts(cap.fetchFn).length).toBe(1);

    const chunked = w3Harness({
      messages: [fileMessage('msg-chunk')],
    });
    chunked.store.chunkOverCap = true;
    await expectHttp(
      chunked.service.incorporateWorkbench('org-a', 'conv-a', KEY_A, {
        kind: 'attachment',
        messageId: 'msg-chunk',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(attachmentPosts(chunked.fetchFn).length).toBe(0);
  });
});
