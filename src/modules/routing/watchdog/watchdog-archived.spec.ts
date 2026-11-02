import { ConversationStatus, MessageDirection } from '@prisma/client';
import { WatchdogCronService } from './watchdog-cron.service';
import { WatchdogTimerProcessor } from './watchdog-timer.processor';
import { WatchdogService } from './watchdog.service';
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
  function setup(row: ReturnType<typeof conversation>, fresh: unknown = row, archivedBeforeCount = false) {
    const prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(row),
        findUnique: jest.fn().mockResolvedValue(fresh),
        update: jest.fn().mockResolvedValue({}),
        // updateMany condicional (isArchived:false): conta 0 se arquivaram no meio.
        updateMany: jest.fn().mockResolvedValue({ count: archivedBeforeCount ? 0 : 1 }),
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
    return { prisma, agentRunner, agentRouter, processor, debug, job };
  }

  it('conversa arquivada → descarta sem atualizar a conversa nem reativar a IA', async () => {
    const { prisma, agentRunner, processor, debug, job } = setup(conversation({ isArchived: true }));

    const result = await processor.process(job);

    expect(result).toEqual({ skipped: true, reason: 'conversation_archived' });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
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
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'c', isArchived: false },
      data: expect.objectContaining({ stuckAttempts: 1 }),
    }));
    expect(agentRunner.run).toHaveBeenCalledTimes(1);
  });

  it('arquivada entre a entrada e a contagem → nada gravado, roteador e IA não rodam', async () => {
    const { prisma, agentRunner, agentRouter, processor, job } = setup(conversation(), conversation(), true);

    const result = await processor.process(job);

    expect(result).toEqual({ skipped: true, reason: 'conversation_archived' });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(agentRouter.shouldHandle).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
  });

  it('`fresh` arquivada (arquivou durante o processamento) → aborta antes do roteador e da IA, sem update', async () => {
    const { prisma, agentRunner, agentRouter, processor, job } = setup(conversation(), conversation({ isArchived: true }));

    const result = await processor.process(job);

    expect(result).toEqual({ skipped: true, reason: 'conversation_archived' });
    expect(agentRouter.shouldHandle).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
});

describe('watchdog — agendar e cancelar não gravam em conversa arquivada', () => {
  type Row = { id: string; isArchived: boolean; watchdogJobId: string | null; stuckAttempts: number; isStuck: boolean };

  function setup(row: Row, arquivarAntesDeGravar = false) {
    const rows = new Map([[row.id, row]]);
    const apply = (r: Row, data: Partial<Row>) => Object.assign(r, data);
    const prisma = {
      conversation: {
        findUnique: jest.fn(async () => ({
          ...row,
          organizationId: 'A',
          channelId: 'ch',
          status: ConversationStatus.PENDING,
          aiEnabled: null,
          organization: { id: 'A', watchdogEnabled: true, watchdogConfig: null },
        })),
        // update grava sem condição; updateMany respeita o where (isArchived).
        update: jest.fn(async ({ where, data }: any) => apply(rows.get(where.id)!, data)),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (arquivarAntesDeGravar) row.isArchived = true;
          const r = rows.get(where.id);
          if (!r || (where.isArchived !== undefined && r.isArchived !== where.isArchived)) return { count: 0 };
          apply(r, data);
          return { count: 1 };
        }),
      },
      channel: { findUnique: jest.fn().mockResolvedValue({ type: 'WHATSAPP_ZAPPFY' }) },
    };
    const job = { remove: jest.fn().mockResolvedValue(undefined) };
    const queue = { add: jest.fn().mockResolvedValue(undefined), getJob: jest.fn().mockResolvedValue(job) };
    const config = { resolve: jest.fn().mockReturnValue({ delayBotMin: 5, delayPendingMin: 5, delayHumanIdleMin: 10, maxAttempts: 3 }) };
    const service = new WatchdogService(prisma as any, config as any, queue as any);
    return { service, queue, job, row };
  }
  const linha = (over: Partial<Row> = {}): Row => ({ id: 'c', isArchived: false, watchdogJobId: null, stuckAttempts: 2, isStuck: true, ...over });

  it('scheduleCheck em arquivada → não agenda job nem grava watchdogJobId', async () => {
    const { service, queue, row } = setup(linha({ isArchived: true }));

    await service.scheduleCheck('c');

    expect(queue.add).not.toHaveBeenCalled();
    expect(row.watchdogJobId).toBeNull();
  });

  it('scheduleCheck: arquivada entre a leitura e a gravação → não grava e retira o job criado', async () => {
    const { service, queue, job, row } = setup(linha(), true);

    await service.scheduleCheck('c');

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(row.watchdogJobId).toBeNull();
    expect(job.remove).toHaveBeenCalled();
  });

  it('scheduleCheck em conversa não arquivada → agenda e grava o watchdogJobId', async () => {
    const { service, queue, row } = setup(linha());

    await service.scheduleCheck('c');

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(row.watchdogJobId).toBe('watchdog-c');
  });

  it('cancelCheck em arquivada → retira o job mas não grava na conversa', async () => {
    const { service, job, row } = setup(linha({ isArchived: true, watchdogJobId: 'watchdog-c' }));

    await service.cancelCheck('c');

    expect(job.remove).toHaveBeenCalled();
    expect(row).toMatchObject({ watchdogJobId: 'watchdog-c', stuckAttempts: 2, isStuck: true });
  });

  it('cancelCheck em conversa não arquivada → zera tentativas e job', async () => {
    const { service, row } = setup(linha({ watchdogJobId: 'watchdog-c' }));

    await service.cancelCheck('c');

    expect(row).toMatchObject({ watchdogJobId: null, stuckAttempts: 0, isStuck: false });
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
