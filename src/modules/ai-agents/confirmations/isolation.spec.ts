import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service';
import { PendingActionStorage } from './pending-action.storage';
import { PendingActionService } from './pending-action.service';
import { PendingActionExecutorProcessor } from './pending-action-executor.processor';
import { EvalRunnerService } from '../evals/runner.service';
import { EvalsController } from '../evals/evals.controller';

describe('Fronteiras da fatia 0', () => {
  it('recusa cadastro sem convite antes de consultar ou gravar', async () => {
    const prisma = { user: { findUnique: jest.fn() }, $transaction: jest.fn() };
    const auth = new AuthService(prisma as any, {} as any, {} as any, {} as any);
    await expect(auth.register({ name: 'Teste', email: 'a@b.com', password: 'senha' } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('aplica organização e canal na consulta de listagem', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const storage = new PendingActionStorage({ aiPendingAction: { findMany } } as any);
    await (storage as any).listByStatus('PENDING', 'org-a', new Set(['canal-a']));
    expect(findMany.mock.calls[0][0].where).toMatchObject({ conversation: { organizationId: 'org-a', channelId: { in: ['canal-a'] } } });
  });
  it('nega ação fora do escopo antes da aprovação', async () => {
    const storage = { getScoped: jest.fn().mockResolvedValue(null), get: jest.fn().mockResolvedValue(null) };
    const queue = { add: jest.fn() };
    const service = new PendingActionService(storage as any, queue as any);
    await expect((service as any).approve('outra', 'u', 'org-a', 'ALL')).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.add).not.toHaveBeenCalled();
    expect(storage.getScoped).toHaveBeenCalled();
  });
  it('não executa aprovação de quem não é membro', async () => {
    const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-a' }), update: jest.fn() }, userOrganization: { findUnique: jest.fn().mockResolvedValue(null) } };
    const storage = { get: jest.fn().mockResolvedValue({ status: 'APPROVED', approvedBy: 'intruso', conversationId: 'c', toolName: 'transferToHuman' }) };
    const processor = new PendingActionExecutorProcessor(prisma as any, {} as any, storage as any);
    await (processor as any).process({ name: 'execute_pending', data: { pendingActionId: 'p' } });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
  it('eval não resolve agente de outra organização', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const controller = new EvalsController({ aiAgent: { findFirst, findUnique: jest.fn().mockResolvedValue({ id: 'outro', name: 'Nome' }) } } as any, {} as any, {} as any);
    await expect((controller as any).run('outro', {}, 'org-a')).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'outro', organizationId: 'org-a' }) }));
  });
});

describe('Fluxos legítimos', () => {
  it('aprova e enfileira a ação acessível', async () => {
    const action = { id: 'p', status: 'PENDING', expiresAt: new Date(Date.now() + 60000).toISOString(), toolName: 'tool' };
    const storage = { getScoped: jest.fn().mockResolvedValue(action), save: jest.fn() };
    const queue = { add: jest.fn() };
    const service = new PendingActionService(storage as any, queue as any);
    const result = await (service as any).approve('p', 'u', 'org-a', new Set(['canal-a']));
    expect(result.status).toBe('APPROVED');
    expect(result.approvedBy).toBe('u');
    expect(queue.add).toHaveBeenCalledWith('execute_pending', { pendingActionId: 'p' }, expect.any(Object));
  });
  it('aceita convite válido e registra associação', async () => {
    const user = { id: 'u', email: 'a@b.com', name: 'Teste', password: 'hash' };
    const org = { id: 'org-a', name: 'Org', slug: 'org', brand: null };
    const membership = { id: 'm', role: 'AGENT' };
    const tx = { user: { create: jest.fn().mockResolvedValue(user) }, userOrganization: { create: jest.fn().mockResolvedValue(membership) }, department: { findFirst: jest.fn().mockResolvedValue(null) }, invitation: { update: jest.fn(), updateMany: jest.fn() } };
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) }, invitation: { findUnique: jest.fn().mockResolvedValue({ id: 'i', email: user.email, organizationId: org.id, organization: org, role: 'AGENT', status: 'PENDING', expiresAt: new Date(Date.now() + 60000) }) }, $transaction: jest.fn((fn) => fn(tx)) };
    const auth = new AuthService(prisma as any, { signAsync: jest.fn().mockResolvedValue('token') } as any, { get: jest.fn().mockReturnValue('secret') } as any, { getAccessibleChannelIds: jest.fn().mockResolvedValue(new Set()) } as any);
    const result = await auth.register({ name: user.name, email: user.email, password: 'senha123', inviteToken: 'convite' });
    expect(result.organizations[0].id).toBe(org.id);
    expect(tx.userOrganization.create).toHaveBeenCalled();
    expect(tx.invitation.update).toHaveBeenCalled();
  });
  it('usa o id validado para executar o caso, mesmo com nome repetido', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'alvo', name: 'Duplicado' });
    const runCase = jest.fn().mockResolvedValue({});
    const controller = new EvalsController({ aiAgent: { findFirst } } as any, { runCase } as any, { buildReport: jest.fn().mockReturnValue({}), writeMarkdown: jest.fn().mockResolvedValue('/tmp/teste') } as any);
    await (controller as any).run('alvo', { cases: [{ name: 'caso', input: 'oi', expect: {} }] }, 'org-a');
    expect(runCase).toHaveBeenCalledWith(expect.any(Object), { agentId: 'alvo' });
  });
});


describe('Runner seleciona por id', () => {
  it('seleciona o agente correto entre nomes iguais', async () => {
    const agents = [{ id: 'outro', name: 'Igual', modelId: 'errado' }, { id: 'alvo', name: 'Igual', modelId: 'certo' }];
    const findFirst = jest.fn(async ({ where }: any) => agents.find((a) => where.id ? a.id === where.id : a.name === where.name));
    const compose = jest.fn().mockReturnValue({ system: 'teste' });
    const runner = new EvalRunnerService({ aiAgent: { findFirst }, aiAgentSkill: { findMany: jest.fn().mockResolvedValue([]) } } as any, { complete: jest.fn().mockResolvedValue({ message: { content: 'ok' } }) } as any, { getLlmDefinitionsForKind: jest.fn().mockReturnValue([]) } as any, { compose } as any, {} as any, {} as any);
    const result = await runner.runCase({ name: 'teste', input: 'oi', expect: {} }, { agentId: 'alvo' });
    expect(result.passed).toBe(true);
    expect(compose.mock.calls[0][0].agent.id).toBe('alvo');
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: 'alvo', isActive: true, deletedAt: null });
  });
});
