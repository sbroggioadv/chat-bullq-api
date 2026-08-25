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
import { MemoryW2Store } from './clickup-inbox-w2.store';
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
      env: workbenchEnv(),
      conv,
      conversations: [conv],
      projects: project ? [project] : [],
      links: project ? [{ conversationId: conv.id, projectId: project.id }] : [],
      messages: opts.messages ?? [textMessage('msg-1', 'contrato assinado'), fileMessage('msg-file')],
      attachments: opts.attachments ?? [],
      store,
      w2Store: opts.w2Store,
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
});
