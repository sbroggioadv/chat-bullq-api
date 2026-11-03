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

describe('watchdog — timer nunca grava nem reativa a IA em conversa arquivada', () => {
  // Fake COM ESTADO: updateMany aplica o where (inclusive isArchived) sobre a
  // linha e devolve a contagem real; update grava sem condição (para provar
  // que não é mais usado); count honra o filtro. `arquivarEm` arquiva a linha
  // durante um await específico do fluxo, simulando o usuário/limpeza.
  type Ponto = 'entrada' | 'horario' | 'ultima_msg' | 'fresh' | 'roteador' | 'gatilho';
  function setup(over: Record<string, unknown> = {}, arquivarEm?: Ponto) {
    const row: any = conversation(over);
    const arquivar = (p: Ponto) => { if (arquivarEm === p) row.isArchived = true; };
    const snapshot = () => ({ ...row });
    const aplica = (where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
    const prisma = {
      conversation: {
        findFirst: jest.fn(async () => { arquivar('entrada'); return snapshot(); }),
        findUnique: jest.fn(async () => { arquivar('fresh'); return snapshot(); }),
        update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
        updateMany: jest.fn(async ({ where, data }: any) => (aplica(where) ? (Object.assign(row, data), { count: 1 }) : { count: 0 })),
        count: jest.fn(async ({ where }: any) => (aplica(where) ? 1 : 0)),
      },
      message: {
        findFirst: jest.fn(async ({ where }: any) => {
          arquivar(where.direction ? 'gatilho' : 'ultima_msg');
          return { id: 'm', direction: MessageDirection.INBOUND, createdAt: new Date('2026-11-02T11:00:00Z') };
        }),
      },
    };
    const config = {
      isWithinBusinessHours: jest.fn(() => { arquivar('horario'); return true; }),
      resolve: jest.fn().mockReturnValue({ maxAttempts: 3 }),
    };
    const notifications = { notify: jest.fn().mockResolvedValue(undefined), notifyOrgAgents: jest.fn().mockResolvedValue(undefined) };
    const agentRunner = { run: jest.fn().mockResolvedValue(undefined) };
    const agentRouter = { shouldHandle: jest.fn(async () => { arquivar('roteador'); return { handle: true }; }) };
    const realtime = { emitToOrg: jest.fn() };
    const processor = new WatchdogTimerProcessor(
      prisma as any, config as any, notifications as any, agentRunner as any, agentRouter as any, realtime as any, {} as any,
    );
    const debug = jest.spyOn((processor as any).logger, 'debug').mockImplementation(() => undefined);
    const job: any = { name: WATCHDOG_CHECK_JOB, data: { conversationId: 'c', organizationId: 'A', scheduledAtAttempts: over.stuckAttempts ?? 0 } };
    return { row, prisma, notifications, agentRunner, agentRouter, processor, debug, job };
  }
  const DESCARTE = { skipped: true, reason: 'conversation_archived' };

  it('já arquivada na entrada → descarta sem gravar nem reativar; log debug sem dado de cliente', async () => {
    const { row, prisma, agentRunner, processor, debug, job } = setup({ isArchived: true, watchdogJobId: 'watchdog-c' });

    expect(await processor.process(job)).toEqual(DESCARTE);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(row.watchdogJobId).toBe('watchdog-c');
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ reason: 'conversation_archived' }));
    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).not.toContain(CLIENTE_NOME);
    expect(logged).not.toContain(CLIENTE_FONE);
  });

  it('não arquivada (ou desarquivada) → fluxo normal: conta tentativa, promove PENDING→BOT e roda a IA', async () => {
    const { row, agentRunner, processor, job } = setup();

    expect(await processor.process(job)).toEqual({ reactivated: true, attempts: 1 });
    expect(row).toMatchObject({ stuckAttempts: 1, status: ConversationStatus.BOT });
    expect(agentRunner.run).toHaveBeenCalledTimes(1);
  });

  it('clearJobId: arquivada durante a checagem de horário (status WAITING) → watchdogJobId intacto', async () => {
    const { row, prisma, processor, job } = setup({ status: ConversationStatus.WAITING, watchdogJobId: 'watchdog-c' }, 'horario');

    expect(await processor.process(job)).toEqual({ skipped: true, reason: 'status_WAITING' });
    expect(row.watchdogJobId).toBe('watchdog-c');
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('markStuck: arquivada antes de marcar presa → não grava isStuck nem notifica os gestores', async () => {
    const { row, prisma, notifications, processor, job } = setup({ stuckAttempts: 3 }, 'ultima_msg');

    expect(await processor.process(job)).toEqual(DESCARTE);
    expect(row).toMatchObject({ isArchived: true, stuckAttempts: 3 });
    expect(row.isStuck).toBeUndefined();
    expect(notifications.notifyOrgAgents).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('contagem de tentativas: arquivada antes de contar → nada gravado, roteador e IA não rodam', async () => {
    const { row, agentRunner, agentRouter, processor, job } = setup({}, 'ultima_msg');

    expect(await processor.process(job)).toEqual(DESCARTE);
    expect(row.stuckAttempts).toBe(0);
    expect(agentRouter.shouldHandle).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
  });

  it('`fresh` arquivada → aborta antes do roteador e da IA', async () => {
    const { agentRunner, agentRouter, processor, job } = setup({}, 'fresh');

    expect(await processor.process(job)).toEqual(DESCARTE);
    expect(agentRouter.shouldHandle).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
  });

  it('promoção para BOT: arquivada DURANTE o roteamento (PENDING) → não promove e não roda a IA', async () => {
    const { row, prisma, agentRunner, processor, job } = setup({}, 'roteador');

    expect(await processor.process(job)).toEqual(DESCARTE);
    expect(row.status).toBe(ConversationStatus.PENDING);
    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('arquivada durante a busca do gatilho (status OPEN, sem promoção) → revalida e não roda a IA', async () => {
    const { agentRunner, processor, job } = setup({ status: ConversationStatus.OPEN }, 'gatilho');

    expect(await processor.process(job)).toEqual(DESCARTE);
    expect(agentRunner.run).not.toHaveBeenCalled();
  });
});

describe('watchdog — agendar e cancelar não gravam em conversa arquivada', () => {
  type Row = { id: string; isGroup?: boolean; isArchived: boolean; watchdogJobId: string | null; stuckAttempts: number; isStuck: boolean };

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

  it('scheduleCheck em grupo não agenda nem grava', async () => {
    const { service, queue, row } = setup(linha({ isGroup: true }));
    await service.scheduleCheck('c');
    expect(queue.add).not.toHaveBeenCalled();
    expect(row.watchdogJobId).toBeNull();
  });

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

describe('SPEC-018 — watchdog não age em grupos', () => {
  it('cron exclui grupo ligado e preserva conversa individual inbound', async () => {
    const rows = [{ id: 'grupo', isGroup: true }, { id: 'individual', isGroup: false }].map(r => ({ ...r, organizationId: 'A', watchdogJobId: null, status: ConversationStatus.PENDING, lastMessageAt: new Date(0) }));
    const prisma = { conversation: { findMany: jest.fn(async ({ where }: any) => rows.filter(r => where.isGroup === undefined || r.isGroup === where.isGroup)) }, message: { findFirst: jest.fn().mockResolvedValue({ direction: MessageDirection.INBOUND }) } };
    const watchdog = { enqueueFromCron: jest.fn() };
    const cron = new WatchdogCronService(prisma as any, watchdog as any, {} as any, {} as any);
    expect(await cron.scanAndEnqueue()).toEqual({ scanned: 1, enqueued: 1 });
    expect(watchdog.enqueueFromCron).toHaveBeenCalledTimes(1);
    expect(watchdog.enqueueFromCron).toHaveBeenCalledWith('individual');
  });
  it('timer descarta grupo ligado antes de alterar ou executar', async () => {
    const row = conversation({ isGroup: true, aiAllowedInGroup: true, watchdogJobId: 'watchdog-c' });
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue(row), findUnique: jest.fn().mockResolvedValue(row), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, message: { findFirst: jest.fn().mockResolvedValue({ id: 'm', direction: MessageDirection.INBOUND }) } };
    const config = { isWithinBusinessHours: jest.fn().mockReturnValue(true), resolve: jest.fn().mockReturnValue({ maxAttempts: 3 }) };
    const runner = { run: jest.fn() }, router = { shouldHandle: jest.fn().mockResolvedValue({ handle: true }) };
    const processor = new WatchdogTimerProcessor(prisma as any, config as any, {} as any, runner as any, router as any, {} as any, {} as any);
    const result = await processor.process({ name: WATCHDOG_CHECK_JOB, data: { conversationId: 'c', organizationId: 'A', scheduledAtAttempts: 0 } } as any);
    expect(result).toEqual({ skipped: true, reason: 'watchdog_skip_group' });
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({ where: { id: 'c', isArchived: false }, data: { watchdogJobId: null } });
    expect(router.shouldHandle).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });
});
