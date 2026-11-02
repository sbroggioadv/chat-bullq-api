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
  const select = ({ where, orderBy, take }: any) => {
    const by = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    const out = rows.filter((r) => ok(r, where)).sort((a, b) => order(a, b, by));
    return take === undefined ? out : out.slice(0, take);
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

  it('extra fundida → 422 conversation_merged, sem gravar', async () => {
    const { service, prisma } = setup(row({ id: 'extra', isArchived: true, metadata: FUNDIDA }));

    await expect(service.setArchived('extra', 'org', false, 'u')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
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
