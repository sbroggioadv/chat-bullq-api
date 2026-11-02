import { UnprocessableEntityException } from '@nestjs/common';
import { ConversationStatus } from '@prisma/client';
import { ConversationFsmService } from './conversation-fsm.service';
import { ConversationsService } from './conversations.service';

// Extra FUNDIDA pela limpeza não volta a ser atendida por id: ligar/fixar/
// acionar IA, reabrir, mudar de estado (exceto encerrar) e atribuir são
// recusados com 422 `conversation_merged` e SEM efeito colateral. Conversa só
// arquivada pelo usuário segue como antes.

const FUNDIDA = { cleanup_merged_into: 'original' };
const conv = (over: Record<string, unknown> = {}) => ({
  id: 'c', organizationId: 'org', channelId: 'ch', contactId: 'ct', status: ConversationStatus.PENDING,
  assignedToId: null, activeAgentId: null, firstResponseAt: null, isArchived: false, metadata: {}, ...over,
});

function fsmSetup(row: ReturnType<typeof conv>) {
  const tx = { conversation: { update: jest.fn() }, conversationAuditLog: { create: jest.fn() } };
  const prisma = {
    conversation: { findUniqueOrThrow: jest.fn().mockResolvedValue(row) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const fsm = new ConversationFsmService(prisma as any, { requestRating: jest.fn().mockResolvedValue(undefined) } as any, outbox as any);
  return { fsm, prisma, tx, outbox };
}

describe('FSM — transição e atribuição', () => {
  it('extra fundida: reabrir (CLOSED→PENDING) é recusado sem transação', async () => {
    const { fsm, prisma } = fsmSetup(conv({ status: ConversationStatus.CLOSED, isArchived: true, metadata: FUNDIDA }));

    await expect(fsm.transition('c', ConversationStatus.PENDING, 'u')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('extra fundida: promover PENDING→OPEN por transição é recusado', async () => {
    const { fsm, prisma } = fsmSetup(conv({ isArchived: true, metadata: FUNDIDA }));

    await expect(fsm.transition('c', ConversationStatus.OPEN, 'u')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('extra fundida: ENCERRAR continua permitido', async () => {
    const { fsm, tx } = fsmSetup(conv({ status: ConversationStatus.OPEN, isArchived: true, metadata: FUNDIDA }));

    await fsm.transition('c', ConversationStatus.CLOSED, 'u');

    expect(tx.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: ConversationStatus.CLOSED }) }));
  });

  it('extra fundida: atribuir (que promoveria PENDING→OPEN) é recusado sem transação nem outbox', async () => {
    const { fsm, prisma, outbox } = fsmSetup(conv({ isArchived: true, metadata: FUNDIDA }));

    await expect(fsm.assign('c', 'agente', 'u')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('arquivada à mão (sem a marca): reabrir e atribuir seguem normais', async () => {
    const fechada = fsmSetup(conv({ status: ConversationStatus.CLOSED, isArchived: true }));
    await fechada.fsm.transition('c', ConversationStatus.PENDING, 'u');
    expect(fechada.tx.conversation.update).toHaveBeenCalled();

    const pendente = fsmSetup(conv({ isArchived: true }));
    await pendente.fsm.assign('c', 'agente', 'u');
    expect(pendente.tx.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: ConversationStatus.OPEN }) }));
  });
});

describe('ConversationsService — IA por id', () => {
  function setup(row: ReturnType<typeof conv>) {
    const prisma = {
      aiAgent: { findFirst: jest.fn().mockResolvedValue({ id: 'ag', name: 'Sofia' }) },
      conversation: { update: jest.fn().mockResolvedValue({ ...row, aiEnabled: true }) },
      conversationAuditLog: { create: jest.fn() },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'm', direction: 'INBOUND' }) },
    };
    const agentRouter = { shouldHandle: jest.fn().mockResolvedValue({ handle: true }) };
    const agentRunner = { run: jest.fn().mockResolvedValue(undefined) };
    const realtime = { emitToConversation: jest.fn(), emitToChannel: jest.fn(), emitToOrg: jest.fn() };
    const fsm = fsmSetup(row).fsm;
    const service = new ConversationsService(
      {} as any, fsm, realtime as any, prisma as any, {} as any, {} as any, {} as any,
      agentRouter as any, agentRunner as any, {} as any, {} as any,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue(row as any);
    jest.spyOn(service as any, 'broadcastUpdate').mockImplementation(() => undefined);
    return { service, prisma, agentRouter, agentRunner };
  }
  const fundida = () => conv({ isArchived: true, metadata: FUNDIDA });

  it('setActiveAgent em extra fundida → 422; não fixa agente, não liga IA, não roda o runner', async () => {
    const { service, prisma, agentRunner } = setup(fundida());

    await expect(service.setActiveAgent('c', 'org', 'ag', 'u')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversationAuditLog.create).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
  });

  it('engageAi em extra fundida → 422; nem roteador nem runner', async () => {
    const { service, agentRouter, agentRunner } = setup(fundida());

    await expect(service.engageAi('c', 'org', 'u')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(agentRouter.shouldHandle).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
  });

  it('toggleAi(true) em extra fundida → 422 sem gravar; toggleAi(false) segue permitido', async () => {
    const { service, prisma } = setup(fundida());

    await expect(service.toggleAi('c', 'org', true, 'u')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.conversation.update).not.toHaveBeenCalled();

    await service.toggleAi('c', 'org', false, 'u').catch(() => undefined);
    expect(prisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ aiEnabled: false }) }));
  });

  it('reopen em extra fundida → 422 (pela FSM), sem transação', async () => {
    const { service } = setup(conv({ status: ConversationStatus.CLOSED, isArchived: true, metadata: FUNDIDA }));

    await expect(service.reopen('c', 'org', 'u')).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('arquivada à mão: setActiveAgent e engageAi seguem rodando a IA', async () => {
    const { service, agentRunner } = setup(conv({ isArchived: true }));

    await expect(service.setActiveAgent('c', 'org', 'ag', 'u')).resolves.toMatchObject({ engaged: true });
    await expect(service.engageAi('c', 'org', 'u')).resolves.toMatchObject({ engaged: true });
    expect(agentRunner.run).toHaveBeenCalledTimes(2);
  });
});
