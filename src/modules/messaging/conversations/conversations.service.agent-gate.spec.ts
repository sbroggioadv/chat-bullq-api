import { ConversationsService } from './conversations.service';
import { AgentRouterService } from '../../ai-agents/router/agent-router.service';

describe('setActiveAgent — gate da organização', () => {
  it.each([
    [{ aiEnabled: false, aiPanicMode: false }, 'org.aiEnabled=false'],
    [{ aiEnabled: true, aiPanicMode: true }, 'ORG_PANIC_MODE'],
  ])('mantém a gravação e não executa quando bloqueado: %s', async (org, reason) => {
    const updated = { id: 'c1', organizationId: 'o1', channelId: 'ch1', aiEnabled: true, activeAgentId: 'a1' };
    const prisma: any = {
      organization: { findUnique: jest.fn().mockResolvedValue(org) },
      channel: { findUnique: jest.fn().mockResolvedValue({}) },
      aiAgent: { findFirst: jest.fn().mockResolvedValue({ id: 'a1', name: 'Agente' }) },
      conversation: { update: jest.fn().mockResolvedValue(updated) },
      conversationAuditLog: { create: jest.fn() },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'm1' }) },
    };
    const router = new AgentRouterService(prisma, {} as any, {} as any, {} as any);
    const runner = { run: jest.fn().mockResolvedValue({}) };
    const realtime = { emitToConversation: jest.fn(), emitToChannel: jest.fn(), emitToOrganization: jest.fn() };
    const service = new ConversationsService({} as any, {} as any, realtime as any, prisma, {} as any, {} as any, {} as any, router, runner as any, {} as any, {} as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({ ...updated, activeAgentId: null } as any);
    const result = await service.setActiveAgent('c1', 'o1', 'a1', 'user');
    expect(prisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ activeAgentId: 'a1', aiEnabled: true }) }));
    expect(result).toEqual({ engaged: false, reason, agentName: 'Agente' });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
