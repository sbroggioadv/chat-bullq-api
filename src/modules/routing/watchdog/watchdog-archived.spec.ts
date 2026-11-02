import { ConversationStatus, MessageDirection } from '@prisma/client';
import { WatchdogCronService } from './watchdog-cron.service';
import { WatchdogTimerProcessor } from './watchdog-timer.processor';
import { WATCHDOG_CHECK_JOB } from './watchdog.types';

// Arquivada = histórico já tratado (ex.: duplicada fundida). O watchdog não
// reativa atendimento sobre ela nem a atualiza.

const CLIENTE_NOME = 'Fulano de Teste';
const CLIENTE_FONE = '5511999990000';

function conversation(over: Record<string, unknown> = {}) {
  return {
    id: 'c',
    organizationId: 'A',
    deletedAt: null,
    isArchived: false,
    status: ConversationStatus.PENDING,
    aiEnabled: null,
    stuckAttempts: 0,
    organization: { watchdogEnabled: true },
    contact: { name: CLIENTE_NOME, phone: CLIENTE_FONE },
    assignedTo: null,
    ...over,
  };
}

describe('watchdog — timer descarta job agendado de conversa arquivada', () => {
  function setup(row: ReturnType<typeof conversation>) {
    const prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(row),
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue({}),
      },
      message: {
        findFirst: jest.fn().mockResolvedValue({ direction: MessageDirection.INBOUND, createdAt: new Date('2026-11-02T11:00:00Z') }),
      },
    };
    const config = { isWithinBusinessHours: jest.fn().mockReturnValue(true), resolve: jest.fn().mockReturnValue({ maxAttempts: 3 }) };
    const notifications = { notify: jest.fn().mockResolvedValue(undefined), notifyOrgAgents: jest.fn() };
    const agentRunner = { run: jest.fn().mockResolvedValue(undefined) };
    const agentRouter = { shouldHandle: jest.fn().mockResolvedValue({ handle: true }) };
    const realtime = { emitToOrg: jest.fn() };
    const processor = new WatchdogTimerProcessor(
      prisma as any, config as any, notifications as any, agentRunner as any, agentRouter as any, realtime as any, {} as any,
    );
    const debug = jest.spyOn((processor as any).logger, 'debug').mockImplementation(() => undefined);
    const job: any = { name: WATCHDOG_CHECK_JOB, data: { conversationId: 'c', organizationId: 'A', scheduledAtAttempts: 0 } };
    return { prisma, agentRunner, processor, debug, job };
  }

  it('conversa arquivada → descarta sem atualizar a conversa nem reativar a IA', async () => {
    const { prisma, agentRunner, processor, debug, job } = setup(conversation({ isArchived: true }));

    const result = await processor.process(job);

    expect(result).toEqual({ skipped: true, reason: 'conversation_archived' });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ reason: 'conversation_archived' }));
    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).not.toContain(CLIENTE_NOME);
    expect(logged).not.toContain(CLIENTE_FONE);
  });

  it('conversa não arquivada (ou desarquivada) segue o fluxo normal do watchdog', async () => {
    const { prisma, agentRunner, processor, job } = setup(conversation({ isArchived: false }));

    const result = await processor.process(job);

    expect(result).toEqual({ reactivated: true, attempts: 1 });
    expect(prisma.conversation.update).toHaveBeenCalled();
    expect(agentRunner.run).toHaveBeenCalledTimes(1);
  });
});

describe('watchdog — cron de fallback ignora conversa arquivada', () => {
  it('arquivada com última mensagem do cliente não é enfileirada', async () => {
    const rows = [{ id: 'arquivada', organizationId: 'A', watchdogJobId: null, status: ConversationStatus.PENDING, lastMessageAt: new Date('2026-11-02T10:00:00Z'), isArchived: true }];
    // O fake aplica só o filtro de arquivamento; os demais filtros do cron
    // (status, aiEnabled, org, canal) seriam satisfeitos por esta linha.
    const prisma = {
      conversation: {
        findMany: jest.fn(async ({ where }: any) =>
          rows.filter((r) => where.isArchived === undefined || r.isArchived === where.isArchived)),
      },
      message: { findFirst: jest.fn().mockResolvedValue({ direction: MessageDirection.INBOUND }) },
    };
    const watchdog = { enqueueFromCron: jest.fn().mockResolvedValue(undefined) };
    const cron = new WatchdogCronService(prisma as any, watchdog as any, {} as any, { getJob: jest.fn() } as any);

    const result = await cron.scanAndEnqueue();

    expect(prisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isArchived: false }) }));
    expect(watchdog.enqueueFromCron).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
  });
});
