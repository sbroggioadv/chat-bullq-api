import { ConversationStatus } from '@prisma/client';
import { InboundMessageProcessor } from './inbound-message.processor';
import { ConversationResolverService } from './conversation-resolver.service';
import { HistoryImportService } from './history-import.service';
import { ChannelSyncProcessor } from '../../channel-hub/sync/channel-sync.processor';
import { MergedConversationError } from '../conversations/merged-conversation';

// Mensagem que ENTRA nunca cai numa extra fundida pela limpeza. Se a conversa
// resolvida virou extra fundida, o inbound REUSA o resolvedor padrão (exclui
// arquivadas, aberta mais recente, reabre fechada recente ou cria nova) — uma
// vez só. Falha nunca some: job falha, webhook_event FAILED e a claim de
// idempotência é LIBERADA para o retry reprocessar.

const NOW = new Date('2026-11-02T12:00:00Z');
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

type Conv = {
  id: string; organizationId: string; channelId: string; contactId: string; status: ConversationStatus;
  isArchived: boolean; isGroup: boolean; lastMessageAt: Date | null; createdAt: Date; closedAt: Date | null;
  deletedAt: Date | null; metadata: Record<string, unknown>; updatedAt: Date;
};
const conv = (over: Partial<Conv> & { id: string }): Conv => ({
  organizationId: 'org', channelId: 'ch', contactId: 'contact', status: ConversationStatus.OPEN, isArchived: false,
  isGroup: false, lastMessageAt: minAgo(60), createdAt: minAgo(6000), closedAt: null, deletedAt: null, metadata: {},
  updatedAt: minAgo(60), ...over,
});

/** Banco fake que aplica where/orderBy do resolvedor (sem lock nenhum). */
function world(initial: Conv[]) {
  const rows = new Map(initial.map((c) => [c.id, c]));
  const messages: any[] = [];
  const match = (c: any, where: any) => Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'status') return v && typeof v === 'object' && 'in' in v ? v.in.includes(c.status) : c.status === v;
    if (!(k in c)) throw new Error(`fake: filtro não suportado ${k}`);
    return c[k] === v;
  });
  const cmp = (a: any, b: any, order: any[]) => {
    for (const e of order) {
      const [k, spec] = Object.entries(e)[0] as [string, any];
      const dir = typeof spec === 'string' ? spec : spec.sort;
      const nulls = (typeof spec === 'object' && spec.nulls) || (dir === 'desc' ? 'first' : 'last');
      const va = a[k]; const vb = b[k];
      if (va === vb) continue;
      if (va === null || vb === null) return (va === null) === (nulls === 'first') ? -1 : 1;
      const x = va instanceof Date ? va.getTime() : va; const y = vb instanceof Date ? vb.getTime() : vb;
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  };
  const prisma: any = {
    conversation: {
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        return [...rows.values()].filter((c) => match(c, where)).sort((a, b) => cmp(a, b, order))[0] ?? null;
      }),
      findMany: jest.fn(async ({ where, orderBy, skip = 0, take }: any) => {
        const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        const sorted = [...rows.values()].filter((c) => match(c, where)).sort((a, b) => cmp(a, b, order));
        return take === undefined ? sorted.slice(skip) : sorted.slice(skip, skip + take);
      }),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const c = conv({ id: `nova-${rows.size + 1}`, ...data, createdAt: NOW, lastMessageAt: null });
        rows.set(c.id, c);
        return c;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(rows.get(where.id)!, data)),
    },
    conversationAuditLog: { create: jest.fn() },
    message: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        const m = { id: `msg-${messages.length + 1}`, type: 'TEXT', ...data };
        messages.push(m);
        return m;
      }),
    },
    $transaction: jest.fn((fn: any) => fn(prisma)),
  };
  /** Simula a limpeza fundindo `extraId` em `originalId` (arquiva + marca). */
  const fundir = (extraId: string, originalId: string) =>
    Object.assign(rows.get(extraId)!, { isArchived: true, metadata: { cleanup_merged_into: originalId } });
  return { prisma, rows, messages, fundir };
}

/** Redis fake com a mesma semântica do IdempotencyService (SET NX / SET / DEL). */
function fakeIdempotency() {
  const keys = new Set<string>();
  return {
    keys,
    claimProcessing: jest.fn(async (ext: string, ch: string) => (keys.has(`${ch}:${ext}`) ? false : (keys.add(`${ch}:${ext}`), true))),
    markProcessed: jest.fn(async (ext: string, ch: string) => { keys.add(`${ch}:${ext}`); }),
    releaseClaim: jest.fn(async (ext: string, ch: string) => { keys.delete(`${ch}:${ext}`); }),
    withLock: (_k: string, fn: () => unknown) => fn(),
  };
}

function inbound(w: ReturnType<typeof world>, opts: { aoResolver?: (n: number) => void; contactResolver?: any; gateway?: any } = {}) {
  const idem = fakeIdempotency();
  const real = new ConversationResolverService(w.prisma, idem as any);
  let n = 0;
  const conversationResolver = {
    resolve: jest.fn(async (...a: [string, string, string, boolean?]) => {
      const r = await real.resolve(...a);
      opts.aoResolver?.(++n);
      return r;
    }),
  };
  const webhookEvents = { markProcessed: jest.fn(), markFailed: jest.fn() };
  const processor = new InboundMessageProcessor(
    w.prisma, idem as any,
    opts.contactResolver ?? { resolve: jest.fn().mockResolvedValue({ contactId: 'contact', isNew: false }) } as any,
    conversationResolver as any,
    opts.gateway ?? { emitToChannel: jest.fn(), emitToConversation: jest.fn() } as any,
    {} as any, {} as any, webhookEvents as any, {} as any, {} as any, {} as any,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as any,
    { scheduleCheck: jest.fn().mockResolvedValue(undefined), cancelCheck: jest.fn().mockResolvedValue(undefined) } as any,
    { add: jest.fn() } as any,
  );
  jest.spyOn(processor as any, 'tryAiAgent').mockResolvedValue(undefined);
  jest.spyOn(processor as any, 'checkActiveBotForChannel').mockResolvedValue(false);
  const job: any = {
    name: 'process-inbound',
    data: {
      channelId: 'ch', organizationId: 'org', webhookEventId: 'wh-1',
      message: { externalMessageId: 'wamid-1', externalContactId: 'ext', channelType: 'WHATSAPP_OFFICIAL', type: 'TEXT', content: { text: 'oi' } },
    },
  };
  return { processor, job, conversationResolver, webhookEvents, idem };
}

describe('inbound — extra fundida reusa o resolvedor padrão (política da original)', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime()));
  afterEach(() => jest.restoreAllMocks());
  // A corrida: o resolvedor escolheu a extra; a limpeza a funde antes da gravação.
  const corrida = (w: ReturnType<typeof world>, extra: string, original: string) =>
    (n: number) => { if (n === 1) w.fundir(extra, original); };

  it('original ABERTA → mensagem na original', async () => {
    const w = world([conv({ id: 'extra', lastMessageAt: minAgo(1) }), conv({ id: 'original', lastMessageAt: minAgo(90) })]);
    const { processor, job, conversationResolver } = inbound(w, { aoResolver: corrida(w, 'extra', 'original') });

    const r = await processor.process(job);

    expect(r).toMatchObject({ conversationId: 'original' });
    expect(conversationResolver.resolve).toHaveBeenCalledTimes(2);
    expect(w.messages.map((m) => m.conversationId)).toEqual(['original']);
  });

  it('original FECHADA há pouco → reabre a original (fluxo normal) e grava nela', async () => {
    const w = world([
      conv({ id: 'extra', lastMessageAt: minAgo(1) }),
      conv({ id: 'original', status: ConversationStatus.CLOSED, closedAt: minAgo(60) }),
    ]);
    const { processor, job } = inbound(w, { aoResolver: corrida(w, 'extra', 'original') });

    const r = await processor.process(job);

    expect(r).toMatchObject({ conversationId: 'original', conversationStatus: ConversationStatus.PENDING });
    expect(w.rows.get('original')!.status).toBe(ConversationStatus.PENDING);
    expect(w.messages.map((m) => m.conversationId)).toEqual(['original']);
  });

  it('original ARQUIVADA à mão → nunca recebe escondida: cria conversa nova visível', async () => {
    const w = world([
      conv({ id: 'extra', lastMessageAt: minAgo(1) }),
      conv({ id: 'original', isArchived: true, lastMessageAt: minAgo(90) }),
    ]);
    const { processor, job } = inbound(w, { aoResolver: corrida(w, 'extra', 'original') });

    const r = await processor.process(job);

    expect(r.conversationId).toMatch(/^nova-/);
    expect(w.messages.map((m) => m.conversationId)).toEqual([r.conversationId]);
    expect(w.rows.get(r.conversationId)!.isArchived).toBe(false);
  });

  it('cadeia A→B→C (a original também foi fundida) → vai para a aberta não arquivada, sem loop', async () => {
    const w = world([
      conv({ id: 'A', lastMessageAt: minAgo(1) }),
      conv({ id: 'B', isArchived: true, metadata: { cleanup_merged_into: 'C' }, lastMessageAt: minAgo(30) }),
      conv({ id: 'C', lastMessageAt: minAgo(300) }),
    ]);
    const { processor, job, conversationResolver } = inbound(w, { aoResolver: corrida(w, 'A', 'B') });

    const r = await processor.process(job);

    expect(r).toMatchObject({ conversationId: 'C' });
    expect(conversationResolver.resolve).toHaveBeenCalledTimes(2);
    expect(w.messages.map((m) => m.conversationId)).toEqual(['C']);
  });

  it('original INEXISTENTE → resolvedor cria conversa nova e grava nela', async () => {
    const w = world([conv({ id: 'extra', lastMessageAt: minAgo(1) })]);
    const { processor, job } = inbound(w, { aoResolver: corrida(w, 'extra', 'nao-existe') });

    const r = await processor.process(job);

    expect(r.conversationId).toMatch(/^nova-/);
    expect(w.messages).toHaveLength(1);
  });

  it('segunda resolução também cai em extra fundida → falha VISÍVEL: nada gravado, webhook FAILED, claim liberada; o retry persiste', async () => {
    const w = world([conv({ id: 'extra', lastMessageAt: minAgo(1) }), conv({ id: 'outra', lastMessageAt: minAgo(90) })]);
    const { processor, job, webhookEvents, idem } = inbound(w, {
      aoResolver: (n) => {
        if (n === 1) w.fundir('extra', 'outra');
        if (n === 2) w.fundir('outra', 'extra'); // marca inconsistente: a re-resolução também é fundida
      },
    });

    await expect(processor.process(job)).rejects.toBeInstanceOf(MergedConversationError);
    expect(w.messages).toHaveLength(0);
    expect(webhookEvents.markFailed).toHaveBeenCalledWith('wh-1', 'conversation_merged');
    expect(idem.releaseClaim).toHaveBeenCalledWith('wamid-1', 'ch');
    expect(idem.keys.size).toBe(0);

    // Retry do BullMQ: sem marcas inconsistentes, a mensagem entra.
    Object.assign(w.rows.get('outra')!, { isArchived: false, metadata: {} });
    const retry = await processor.process(job);
    expect(retry).toMatchObject({ conversationId: 'outra' });
    expect(w.messages).toHaveLength(1);
  });
});

describe('inbound — claim de idempotência (preexistente em f6d34ed)', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime()));
  afterEach(() => jest.restoreAllMocks());

  it('falha ANTES de persistir libera a claim: o retry persiste a mensagem (não volta duplicate_claim)', async () => {
    const w = world([conv({ id: 'c1' })]);
    const contactResolver = { resolve: jest.fn().mockRejectedValueOnce(new Error('db_timeout')).mockResolvedValue({ contactId: 'contact', isNew: false }) };
    const { processor, job } = inbound(w, { contactResolver });

    await expect(processor.process(job)).rejects.toThrow('db_timeout');
    const retry = await processor.process(job);

    expect(retry).toMatchObject({ conversationId: 'c1' });
    expect(retry).not.toMatchObject({ reason: 'duplicate_claim' });
    expect(w.messages).toHaveLength(1);
  });

  it('markFailed falha → a claim é liberada mesmo assim e o retry persiste', async () => {
    const w = world([conv({ id: 'c1' })]);
    const contactResolver = { resolve: jest.fn().mockRejectedValueOnce(new Error('db_timeout')).mockResolvedValue({ contactId: 'contact', isNew: false }) };
    const { processor, job, webhookEvents, idem } = inbound(w, { contactResolver });
    webhookEvents.markFailed.mockRejectedValueOnce(new Error('webhook_db_down'));

    await expect(processor.process(job)).rejects.toThrow('db_timeout');
    expect(idem.releaseClaim).toHaveBeenCalledWith('wamid-1', 'ch');
    const retry = await processor.process(job);

    expect(retry).toMatchObject({ conversationId: 'c1' });
    expect(w.messages).toHaveLength(1);
  });

  it('markFailed E a liberação falham → relança o erro ORIGINAL e loga as duas falhas sem mascarar', async () => {
    const w = world([conv({ id: 'c1' })]);
    const contactResolver = { resolve: jest.fn().mockRejectedValueOnce(new Error('db_timeout')) };
    const { processor, job, webhookEvents, idem } = inbound(w, { contactResolver });
    webhookEvents.markFailed.mockRejectedValueOnce(new Error('webhook_db_down'));
    idem.releaseClaim.mockRejectedValueOnce(new Error('redis_down'));
    const warn = jest.spyOn((processor as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(processor.process(job)).rejects.toThrow('db_timeout');
    expect(idem.releaseClaim).toHaveBeenCalledTimes(1);
    const avisos = JSON.stringify(warn.mock.calls);
    expect(avisos).toContain('webhook_db_down');
    expect(avisos).toContain('redis_down');
  });

  it('falha DEPOIS de persistir mantém a claim: o retry não reprocessa (sem efeito em dobro)', async () => {
    const w = world([conv({ id: 'c1' })]);
    const gateway = { emitToChannel: jest.fn().mockImplementationOnce(() => { throw new Error('socket'); }), emitToConversation: jest.fn() };
    const { processor, job, idem } = inbound(w, { gateway });

    await expect(processor.process(job)).rejects.toThrow('socket');
    const retry = await processor.process(job);

    expect(retry).toEqual({ skipped: true, reason: 'duplicate_claim' });
    expect(idem.releaseClaim).not.toHaveBeenCalled();
    expect(w.messages).toHaveLength(1);
  });
});

describe('importação — extra fundida não recebe página (leitura comum, sem lock)', () => {
  const channel: any = { id: 'ch', organizationId: 'org', type: 'WHATSAPP_ZAPPFY' };
  const page = [{ externalMessageId: 'm1', timestamp: new Date('2026-11-01T10:00:00Z'), direction: 'INBOUND', type: 'TEXT', content: {} }] as any;
  function svc(metadata: unknown) {
    // Sem $queryRaw no fake: SQL cru (ex.: FOR SHARE) quebraria este teste.
    const tx = {
      conversation: { findUnique: jest.fn().mockResolvedValue({ metadata }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      message: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    return { tx, service: new HistoryImportService({ $transaction: jest.fn((fn: any) => fn(tx)) } as any, {} as any) };
  }

  it('página para extra fundida → MergedConversationError, nada gravado', async () => {
    const { tx, service } = svc({ cleanup_merged_into: 'original' });

    await expect(service.importMessages(channel, 'extra', page)).rejects.toBeInstanceOf(MergedConversationError);
    expect(tx.message.createMany).not.toHaveBeenCalled();
  });

  it('página para conversa sem a marca → gravada nela', async () => {
    const { tx, service } = svc({});

    await expect(service.importMessages(channel, 'c1', page)).resolves.toEqual({ imported: 1, skipped: 0 });
    expect(tx.message.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ conversationId: 'c1' })] }));
  });
});

describe('sincronização — re-resolve uma vez; falha vira pendência visível (não COMPLETED limpo)', () => {
  function setup(importer: any, conversas = [{ externalConversationId: 'jid-1' }]) {
    const prisma = {
      channelSyncJob: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job', status: 'PENDING', lookbackDays: 30 }),
        update: jest.fn().mockResolvedValue({}),
      },
      channel: { findUnique: jest.fn().mockResolvedValue({ id: 'ch', organizationId: 'org', type: 'WHATSAPP_ZAPPFY' }) },
    };
    const msg = { externalMessageId: 'm', timestamp: new Date(), direction: 'INBOUND', type: 'TEXT', content: {} };
    const adapter = {
      fetchConversations: jest.fn().mockResolvedValue({ conversations: conversas, nextCursor: undefined }),
      fetchMessages: jest.fn().mockResolvedValue({ messages: [msg] }),
    };
    const processor = new ChannelSyncProcessor(prisma as any, { getHistorySync: () => adapter } as any, {} as any, importer);
    jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
    jest.spyOn(processor as any, 'isCancelled').mockResolvedValue(false);
    const progress = jest.spyOn(processor as any, 'emitProgress').mockImplementation(() => undefined);
    const final = () => {
      const calls = prisma.channelSyncJob.update.mock.calls;
      return calls[calls.length - 1][0].data;
    };
    return { processor, final, progress };
  }
  const job: any = { data: { syncJobId: 'job', channelId: 'ch' } };

  it('extra fundida → re-resolve pela resolução do importador e importa no novo destino; COMPLETED', async () => {
    const importer = {
      importConversation: jest.fn()
        .mockResolvedValueOnce({ conversationId: 'extra', contactId: 'c', isNew: false })
        .mockResolvedValueOnce({ conversationId: 'original', contactId: 'c', isNew: false }),
      importMessages: jest.fn(async (_ch: any, id: string) => {
        if (id === 'extra') throw new MergedConversationError('extra');
        return { imported: 1, skipped: 0 };
      }),
      notifyConversationImported: jest.fn().mockResolvedValue(undefined),
    };
    const { processor, final } = setup(importer);

    await processor.process(job);

    expect(importer.importConversation).toHaveBeenCalledTimes(2);
    expect(importer.notifyConversationImported).toHaveBeenCalledWith('org', 'original');
    expect(final()).toMatchObject({ status: 'COMPLETED', conversationsImported: 1, messagesImported: 1 });
  });

  it('só a publicação de progresso falha (aviso à caixa) → conversa conta como importada, job COMPLETED sem pendência', async () => {
    const importer = {
      importConversation: jest.fn().mockResolvedValue({ conversationId: 'c1', contactId: 'c', isNew: false }),
      importMessages: jest.fn().mockResolvedValue({ imported: 1, skipped: 0 }),
      notifyConversationImported: jest.fn().mockRejectedValue(new Error('socket_down')),
    };
    const { processor, final } = setup(importer);

    await processor.process(job);

    expect(final()).toMatchObject({ status: 'COMPLETED', conversationsImported: 1, messagesImported: 1 });
    expect(final().errorMessage).toBeUndefined();
  });

  it('segunda tentativa também falha → job FAILED com contagem e id da conversa pendente (as outras entram)', async () => {
    const importer = {
      importConversation: jest.fn(async (_ch: any, c: any) => ({ conversationId: c.externalConversationId === 'jid-ruim' ? 'extra' : 'boa', contactId: 'c', isNew: false })),
      importMessages: jest.fn(async (_ch: any, id: string) => {
        if (id === 'extra') throw new MergedConversationError('extra');
        return { imported: 1, skipped: 0 };
      }),
      notifyConversationImported: jest.fn().mockResolvedValue(undefined),
    };
    const { processor, final, progress } = setup(importer, [{ externalConversationId: 'jid-ruim' }, { externalConversationId: 'jid-ok' }]);

    await processor.process(job);

    expect(importer.importConversation).toHaveBeenCalledTimes(3); // ruim: 2 (uma re-resolução), ok: 1
    expect(final()).toMatchObject({
      status: 'FAILED',
      conversationsImported: 1,
      errorMessage: expect.stringContaining('1 de 2'),
      metadata: { conversationsFailed: 1, failedExternalConversationIds: ['jid-ruim'] },
    });
    expect(progress).toHaveBeenLastCalledWith('org', 'job', 'ch', expect.objectContaining({ status: 'FAILED', errorMessage: expect.any(String) }));
  });
});
