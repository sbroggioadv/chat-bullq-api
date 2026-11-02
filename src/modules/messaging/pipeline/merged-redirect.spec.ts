import { InboundMessageProcessor } from './inbound-message.processor';
import { HistoryImportService } from './history-import.service';
import { ChannelSyncProcessor } from '../../channel-hub/sync/channel-sync.processor';
import { MergedConversationError } from '../conversations/merged-conversation';

// Mensagem que ENTRA (cliente ao vivo ou histórico importado) nunca cai
// escondida numa extra fundida pela limpeza: vai para a original. Se a
// original não serve, o destino é re-resolvido uma vez.

const FUNDIDA = { cleanup_merged_into: 'original' };

/** tx fake: `rows` = estado commitado lido pelo SELECT … FOR SHARE, por id. */
function fakeTx(rows: Record<string, { metadata: unknown; status: string }>, originals: Record<string, any>) {
  return {
    $queryRaw: jest.fn(async (sql: any) => (rows[sql.values[0]] ? [rows[sql.values[0]]] : [])),
    conversation: {
      findFirst: jest.fn(async ({ where }: any) => {
        const o = originals[where.id];
        return o && o.organizationId === where.organizationId && o.channelId === where.channelId && !o.deletedAt ? o : null;
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    message: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: 'msg-1', type: 'TEXT', ...data })),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('inbound ao vivo — redireciona extra fundida para a original', () => {
  function setup(tx: ReturnType<typeof fakeTx>, resolutions: Array<{ conversationId: string; status: string }>) {
    const prisma = { $transaction: jest.fn((fn: any) => fn(tx)) };
    const conversationResolver = { resolve: jest.fn() };
    resolutions.forEach((r) => conversationResolver.resolve.mockResolvedValueOnce(r));
    const watchdog = { scheduleCheck: jest.fn().mockResolvedValue(undefined), cancelCheck: jest.fn().mockResolvedValue(undefined) };
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const processor = new InboundMessageProcessor(
      prisma as any,
      { claimProcessing: jest.fn().mockResolvedValue(true), markProcessed: jest.fn().mockResolvedValue(undefined) } as any,
      { resolve: jest.fn().mockResolvedValue({ contactId: 'contact', isNew: false }) } as any,
      conversationResolver as any,
      { emitToChannel: jest.fn(), emitToConversation: jest.fn() } as any,
      {} as any, {} as any, { markProcessed: jest.fn() } as any, {} as any, {} as any, {} as any,
      outbox as any, watchdog as any, { add: jest.fn() } as any,
    );
    jest.spyOn(processor as any, 'tryAiAgent').mockResolvedValue(undefined);
    jest.spyOn(processor as any, 'checkActiveBotForChannel').mockResolvedValue(false);
    const job: any = {
      name: 'process-message',
      data: {
        channelId: 'ch',
        organizationId: 'org',
        message: { externalMessageId: 'wamid-1', externalContactId: 'ext', channelType: 'WHATSAPP_OFFICIAL', type: 'TEXT', content: { text: 'oi' } },
      },
    };
    return { processor, job, conversationResolver, watchdog, outbox };
  }

  it('resolvida para extra fundida (corrida com a fusão) → mensagem, outbox e watchdog vão para a original', async () => {
    const tx = fakeTx(
      { extra: { metadata: FUNDIDA, status: 'OPEN' }, original: { metadata: {}, status: 'OPEN' } },
      { original: { id: 'original', status: 'OPEN', organizationId: 'org', channelId: 'ch', deletedAt: null, metadata: {} } },
    );
    const { processor, job, watchdog, outbox } = setup(tx, [{ conversationId: 'extra', status: 'OPEN' }]);

    const r = await processor.process(job);

    expect(r).toMatchObject({ conversationId: 'original' });
    expect(tx.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conversationId: 'original' }) }));
    expect(tx.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'original' } }));
    expect(tx.conversation.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'extra' } }));
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ conversationId: 'original' }));
    expect(watchdog.scheduleCheck).toHaveBeenCalledWith('original');
  });

  it('original indisponível (outra organização) → re-resolve uma vez e grava no novo destino', async () => {
    const tx = fakeTx(
      { extra: { metadata: FUNDIDA, status: 'OPEN' }, nova: { metadata: {}, status: 'PENDING' } },
      { original: { id: 'original', status: 'OPEN', organizationId: 'OUTRA', channelId: 'ch', deletedAt: null, metadata: {} } },
    );
    const { processor, job, conversationResolver } = setup(tx, [
      { conversationId: 'extra', status: 'OPEN' },
      { conversationId: 'nova', status: 'PENDING' },
    ]);

    const r = await processor.process(job);

    expect(conversationResolver.resolve).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ conversationId: 'nova' });
    expect(tx.message.create).toHaveBeenCalledTimes(1);
    expect(tx.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conversationId: 'nova' }) }));
  });

  it('conversa sem a marca → grava nela mesma (revalidação no FOR SHARE, sem desvio)', async () => {
    const tx = fakeTx({ conv: { metadata: {}, status: 'OPEN' } }, {});
    const { processor, job } = setup(tx, [{ conversationId: 'conv', status: 'OPEN' }]);

    const r = await processor.process(job);

    expect(r).toMatchObject({ conversationId: 'conv' });
    expect(tx.$queryRaw.mock.calls[0][0].sql).toContain('FOR SHARE');
    expect(tx.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conversationId: 'conv' }) }));
  });
});

describe('importação de histórico — redireciona extra fundida para a original', () => {
  const channel: any = { id: 'ch', organizationId: 'org', type: 'WHATSAPP_ZAPPFY' };
  const page = [{ externalMessageId: 'm1', timestamp: new Date('2026-11-01T10:00:00Z'), direction: 'INBOUND', type: 'TEXT', content: {} }] as any;

  it('página destinada a extra fundida → gravada na original e o id da original é devolvido', async () => {
    const tx = fakeTx(
      { extra: { metadata: FUNDIDA, status: 'OPEN' } },
      { original: { id: 'original', status: 'OPEN', organizationId: 'org', channelId: 'ch', deletedAt: null, metadata: {} } },
    );
    const prisma = { $transaction: jest.fn((fn: any) => fn(tx)) };
    const service = new HistoryImportService(prisma as any, {} as any);

    const r = await service.importMessages(channel, 'extra', page);

    expect(r).toEqual({ imported: 1, skipped: 0, conversationId: 'original' });
    expect(tx.message.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ conversationId: 'original' })],
    }));
    expect(tx.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'original' }) }));
  });

  it('original indisponível → MergedConversationError (nada gravado)', async () => {
    const tx = fakeTx({ extra: { metadata: FUNDIDA, status: 'OPEN' } }, {});
    const service = new HistoryImportService({ $transaction: jest.fn((fn: any) => fn(tx)) } as any, {} as any);

    await expect(service.importMessages(channel, 'extra', page)).rejects.toBeInstanceOf(MergedConversationError);
    expect(tx.message.createMany).not.toHaveBeenCalled();
  });
});

describe('sincronização de canal — segue o desvio entre páginas e re-resolve uma vez', () => {
  function setup(importer: any, pages: Array<{ messages: any[]; nextCursor?: string }>) {
    const prisma = {
      channelSyncJob: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job', status: 'PENDING', lookbackDays: 30 }),
        update: jest.fn().mockResolvedValue({}),
      },
      channel: { findUnique: jest.fn().mockResolvedValue({ id: 'ch', organizationId: 'org', type: 'WHATSAPP_ZAPPFY' }) },
    };
    const adapter = {
      fetchConversations: jest.fn().mockResolvedValue({ conversations: [{ externalConversationId: 'jid' }], nextCursor: undefined }),
      fetchMessages: jest.fn(),
    };
    pages.forEach((p) => adapter.fetchMessages.mockResolvedValueOnce(p));
    const processor = new ChannelSyncProcessor(
      prisma as any,
      { getHistorySync: () => adapter } as any,
      { emitToOrg: jest.fn(), emitToChannel: jest.fn() } as any,
      importer,
    );
    jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
    jest.spyOn(processor as any, 'isCancelled').mockResolvedValue(false);
    jest.spyOn(processor as any, 'emitProgress').mockImplementation(() => undefined);
    return { processor, adapter };
  }
  const msg = { externalMessageId: 'm', timestamp: new Date(), direction: 'INBOUND', type: 'TEXT', content: {} };

  it('desvio na 1ª página → a 2ª página e o aviso de importação já vão para a original', async () => {
    const importer = {
      importConversation: jest.fn().mockResolvedValue({ conversationId: 'extra', contactId: 'c', isNew: false }),
      importMessages: jest.fn(async (_ch: any, conversationId: string) => ({
        imported: 1, skipped: 0, conversationId: conversationId === 'extra' ? 'original' : conversationId,
      })),
      notifyConversationImported: jest.fn().mockResolvedValue(undefined),
    };
    const { processor } = setup(importer, [{ messages: [msg], nextCursor: 'p2' }, { messages: [msg] }]);

    await processor.process({ data: { syncJobId: 'job', channelId: 'ch' } } as any);

    expect(importer.importMessages.mock.calls.map((c: any[]) => c[1])).toEqual(['extra', 'original']);
    expect(importer.notifyConversationImported).toHaveBeenCalledWith('org', 'original');
  });

  it('original indisponível → re-resolve a conversa uma vez e importa no novo destino', async () => {
    const importer = {
      importConversation: jest.fn()
        .mockResolvedValueOnce({ conversationId: 'extra', contactId: 'c', isNew: false })
        .mockResolvedValueOnce({ conversationId: 'boa', contactId: 'c', isNew: false }),
      importMessages: jest.fn(async (_ch: any, conversationId: string) => {
        if (conversationId === 'extra') throw new MergedConversationError('extra');
        return { imported: 1, skipped: 0, conversationId };
      }),
      notifyConversationImported: jest.fn().mockResolvedValue(undefined),
    };
    const { processor } = setup(importer, [{ messages: [msg] }, { messages: [msg] }]);

    await processor.process({ data: { syncJobId: 'job', channelId: 'ch' } } as any);

    expect(importer.importConversation).toHaveBeenCalledTimes(2);
    expect(importer.importMessages.mock.calls.map((c: any[]) => c[1])).toEqual(['extra', 'boa']);
    expect(importer.notifyConversationImported).toHaveBeenCalledWith('org', 'boa');
  });
});
