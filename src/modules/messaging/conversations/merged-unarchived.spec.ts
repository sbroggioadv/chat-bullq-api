import { UnprocessableEntityException } from '@nestjs/common';
import { ChannelType, ConversationStatus, MessageDirection } from '@prisma/client';
import { ConversationsService } from './conversations.service';
import { ConversationResolverService } from '../pipeline/conversation-resolver.service';
import { HistoryImportService } from '../pipeline/history-import.service';
import { WatchdogCronService } from '../../routing/watchdog/watchdog-cron.service';
import { WatchdogTimerProcessor } from '../../routing/watchdog/watchdog-timer.processor';
import { WatchdogService } from '../../routing/watchdog/watchdog.service';
import { WATCHDOG_CHECK_JOB } from '../../routing/watchdog/watchdog.types';

// A MARCA decide, não o isArchived: extra fundida que alguém desarquivou (ou
// que já estava desarquivada) continua fora de toda seleção automática, e
// desarquivar extra fundida é recusado. Conversa arquivada comum segue igual.

const NOW = new Date('2026-11-02T12:00:00Z');
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const FUNDIDA = { cleanup_merged_into: 'original' };

type Row = Record<string, any>;
const row = (over: Row): Row => ({
  organizationId: 'org', channelId: 'ch', contactId: 'contact', status: ConversationStatus.OPEN, isArchived: false,
  isGroup: false, lastMessageAt: minAgo(60), createdAt: minAgo(6000), closedAt: null, updatedAt: minAgo(60), metadata: {}, ...over,
});

/** findMany fake: aplica where (igualdade, status.in, metadata.path) + orderBy + take. */
function fakeConversations(rows: Row[]) {
  const ok = (r: Row, where: Row) => Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'status') return v?.in ? v.in.includes(r.status) : r.status === v;
    if (k === 'metadata') return r.metadata?.[v.path[0]] === v.equals;
    return r[k] === v;
  });
  const order = (a: Row, b: Row, by: any[]) => {
    for (const e of by) {
      const [k, s] = Object.entries(e)[0] as [string, any];
      const dir = typeof s === 'string' ? s : s.sort;
      const x = a[k]?.getTime?.() ?? a[k]; const y = b[k]?.getTime?.() ?? b[k];
      if (x === y) continue;
      if (x == null) return 1; if (y == null) return -1;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  };
  const select = ({ where, orderBy, skip = 0, take }: any) => {
    const by = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    const out = rows.filter((r) => ok(r, where)).sort((a, b) => order(a, b, by));
    return take === undefined ? out.slice(skip) : out.slice(skip, skip + take);
  };
  // findFirst também, para o controle negativo (código antigo) mostrar a
  // escolha errada em vez de um TypeError estrutural.
  return {
    findMany: jest.fn(async (args: any) => select(args)),
    findFirst: jest.fn(async (args: any) => select(args)[0] ?? null),
  };
}

describe('desarquivar extra fundida é recusado', () => {
  function setup(current: Row) {
    const prisma = { conversation: { update: jest.fn().mockResolvedValue(current) }, conversationAuditLog: { create: jest.fn() } };
    const service = new ConversationsService({} as any, {} as any, {} as any, prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    jest.spyOn(service, 'findOne').mockResolvedValue(current as any);
    jest.spyOn(service as any, 'broadcastUpdate').mockImplementation(() => undefined);
    return { service, prisma };
  }

  it('extra fundida → 422 com code conversation_merged, sem gravar nem auditar', async () => {
    const { service, prisma } = setup(row({ id: 'extra', isArchived: true, metadata: FUNDIDA }));

    const err = await service.setArchived('extra', 'org', false, 'u').catch((e) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'conversation_merged', mergedInto: 'original' });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversationAuditLog.create).not.toHaveBeenCalled();
  });

  it('arquivar extra fundida (de novo) continua permitido', async () => {
    const { service, prisma } = setup(row({ id: 'extra', isArchived: false, metadata: FUNDIDA }));

    await service.setArchived('extra', 'org', true, 'u');

    expect(prisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isArchived: true }) }));
  });

  it('conversa arquivada comum continua desarquivável', async () => {
    const { service, prisma } = setup(row({ id: 'comum', isArchived: true }));

    await service.setArchived('comum', 'org', false, 'u');

    expect(prisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isArchived: false }) }));
  });
});

describe('extra fundida JÁ desarquivada fica fora das seleções automáticas', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime()));
  afterEach(() => jest.restoreAllMocks());

  it('resolvedor ao vivo: pula a extra desarquivada (mais recente) e escolhe a original', async () => {
    const rows = [row({ id: 'extra', metadata: FUNDIDA, lastMessageAt: minAgo(1) }), row({ id: 'original', lastMessageAt: minAgo(90) })];
    const prisma = { conversation: { ...fakeConversations(rows) } };
    const resolver = new ConversationResolverService(prisma as any, { withLock: (_k: string, fn: () => unknown) => fn() } as any);

    await expect(resolver.resolve('org', 'ch', 'contact')).resolves.toMatchObject({ conversationId: 'original', isNew: false });
  });

  it('resolvedor ao vivo: não reabre extra fundida fechada (mais recente); reabre a original', async () => {
    const rows = [
      row({ id: 'extra', metadata: FUNDIDA, status: ConversationStatus.CLOSED, closedAt: minAgo(10) }),
      row({ id: 'original', status: ConversationStatus.CLOSED, closedAt: minAgo(120) }),
    ];
    const prisma = { conversation: { ...fakeConversations(rows), update: jest.fn() }, conversationAuditLog: { create: jest.fn() } };
    const resolver = new ConversationResolverService(prisma as any, { withLock: (_k: string, fn: () => unknown) => fn() } as any);

    await expect(resolver.resolve('org', 'ch', 'contact')).resolves.toMatchObject({ conversationId: 'original', wasReopened: true });
    expect(prisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'original' } }));
  });

  it('importador: pula a extra desarquivada na busca por thread e na busca por contato', async () => {
    const rows = [
      row({ id: 'extra', metadata: { ...FUNDIDA, externalConversationId: 'jid' }, lastMessageAt: minAgo(1) }),
      row({ id: 'original', lastMessageAt: minAgo(90) }),
    ];
    const prisma = {
      contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'cc', contactId: 'contact', profileName: 'N', contact: { organizationId: 'org' } }), update: jest.fn() },
      conversation: { ...fakeConversations(rows), update: jest.fn(), create: jest.fn() },
    };
    const importer = new HistoryImportService(prisma as any, {} as any);

    const r = await importer.importConversation({ id: 'ch', organizationId: 'org', type: ChannelType.WHATSAPP_ZAPPFY } as any, { externalContactId: 'e', contactName: 'N', externalConversationId: 'jid' } as any);

    expect(r).toMatchObject({ conversationId: 'original', isNew: false });
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  // Original atrás de N extras fundidas (todas mais recentes): a seleção
  // pagina na mesma ordem e nunca cria conversa nova à toa.
  const fundidasAntes = (n: number) => [
    ...Array.from({ length: n }, (_, i) => row({ id: `extra-${String(i).padStart(2, '0')}`, metadata: { ...FUNDIDA, externalConversationId: 'jid' }, lastMessageAt: minAgo(1 + i) })),
    // A limpeza grava o externalConversationId da extra na original.
    row({ id: 'original', lastMessageAt: minAgo(500), metadata: { externalConversationId: 'jid' } }),
  ];

  it.each([10, 24])('resolvedor: original na posição %d+1 (atrás de extras fundidas) é achada, sem criar conversa', async (n) => {
    const conversation = { ...fakeConversations(fundidasAntes(n)), create: jest.fn() };
    const resolver = new ConversationResolverService({ conversation } as any, { withLock: (_k: string, fn: () => unknown) => fn() } as any);

    await expect(resolver.resolve('org', 'ch', 'contact')).resolves.toMatchObject({ conversationId: 'original', isNew: false });
    expect(conversation.create).not.toHaveBeenCalled();
    expect(conversation.findMany).toHaveBeenCalledTimes(Math.floor(n / 10) + 1);
  });

  it.each([10, 24])('importador (contato e thread): original na posição %d+1 é achada, sem criar conversa', async (n) => {
    const conversation = { ...fakeConversations(fundidasAntes(n)), update: jest.fn(), create: jest.fn() };
    const prisma = {
      contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'cc', contactId: 'contact', profileName: 'N', contact: { organizationId: 'org' } }), update: jest.fn() },
      conversation,
    };
    const importer = new HistoryImportService(prisma as any, {} as any);
    const canal = { id: 'ch', organizationId: 'org', type: ChannelType.WHATSAPP_ZAPPFY } as any;

    const porContato = await importer.importConversation(canal, { externalContactId: 'e', contactName: 'N' } as any);
    const porThread = await importer.importConversation(canal, { externalContactId: 'e', contactName: 'N', externalConversationId: 'jid' } as any);

    expect(porContato).toMatchObject({ conversationId: 'original', isNew: false });
    expect(porThread).toMatchObject({ conversationId: 'original', isNew: false });
    expect(conversation.create).not.toHaveBeenCalled();
  });

  it('sem extra fundida → UMA consulta só (resolvedor e importador)', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => row({ id: `c-${i}`, lastMessageAt: minAgo(1 + i) }));
    const conversation = { ...fakeConversations(rows), create: jest.fn(), update: jest.fn() };
    const resolver = new ConversationResolverService({ conversation } as any, { withLock: (_k: string, fn: () => unknown) => fn() } as any);

    await expect(resolver.resolve('org', 'ch', 'contact')).resolves.toMatchObject({ conversationId: 'c-0' });
    expect(conversation.findMany).toHaveBeenCalledTimes(1);

    conversation.findMany.mockClear();
    const importer = new HistoryImportService({
      contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'cc', contactId: 'contact', profileName: 'N', contact: { organizationId: 'org' } }), update: jest.fn() },
      conversation,
    } as any, {} as any);
    await expect(importer.importConversation({ id: 'ch', organizationId: 'org', type: ChannelType.WHATSAPP_ZAPPFY } as any, { externalContactId: 'e', contactName: 'N' } as any))
      .resolves.toMatchObject({ conversationId: 'c-0' });
    expect(conversation.findMany).toHaveBeenCalledTimes(1);
  });

  it('watchdog cron: extra fundida desarquivada com última mensagem do cliente não é enfileirada', async () => {
    const prisma = {
      conversation: { findMany: jest.fn().mockResolvedValue([{ id: 'extra', organizationId: 'org', watchdogJobId: null, status: 'PENDING', lastMessageAt: minAgo(30), metadata: FUNDIDA }]) },
      message: { findFirst: jest.fn().mockResolvedValue({ direction: MessageDirection.INBOUND }) },
    };
    const watchdog = { enqueueFromCron: jest.fn() };
    const cron = new WatchdogCronService(prisma as any, watchdog as any, {} as any, { getJob: jest.fn() } as any);

    await cron.scanAndEnqueue();

    expect(watchdog.enqueueFromCron).not.toHaveBeenCalled();
  });

  it('watchdog timer: job de extra fundida desarquivada é descartado sem gravar nem rodar IA', async () => {
    const conv = { ...row({ id: 'extra', metadata: FUNDIDA, status: ConversationStatus.PENDING }), deletedAt: null, aiEnabled: null, stuckAttempts: 0, organization: { watchdogEnabled: true }, contact: { name: 'X', phone: '1' }, assignedTo: null };
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue(conv), update: jest.fn(), updateMany: jest.fn() }, message: { findFirst: jest.fn() } };
    const runner = { run: jest.fn() };
    const timer = new WatchdogTimerProcessor(prisma as any, { isWithinBusinessHours: () => true } as any, {} as any, runner as any, {} as any, {} as any, {} as any);

    const r = await timer.process({ name: WATCHDOG_CHECK_JOB, data: { conversationId: 'extra', organizationId: 'org', scheduledAtAttempts: 0 } } as any);

    expect(r).toEqual({ skipped: true, reason: 'conversation_archived' });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('watchdog scheduleCheck: extra fundida desarquivada não ganha job', async () => {
    const prisma = {
      conversation: { findUnique: jest.fn().mockResolvedValue({ ...row({ id: 'extra', metadata: FUNDIDA, status: ConversationStatus.PENDING }), aiEnabled: null, stuckAttempts: 0, organization: { id: 'org', watchdogEnabled: true, watchdogConfig: null } }), updateMany: jest.fn() },
      channel: { findUnique: jest.fn().mockResolvedValue({ type: 'WHATSAPP_ZAPPFY' }) },
    };
    const queue = { add: jest.fn(), getJob: jest.fn() };
    const service = new WatchdogService(prisma as any, { resolve: () => ({ delayPendingMin: 5 }) } as any, queue as any);

    await service.scheduleCheck('extra');

    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });
});
