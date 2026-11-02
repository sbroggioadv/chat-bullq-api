import { AgentsService } from './agents.service';

describe('AgentsService — criação sem vínculo automático', () => {
  it('não vincula os três canais ativos ao criar agente', async () => {
    const agent = { id: 'agent-1' };
    const prisma = {
      aiAgent: { create: jest.fn().mockResolvedValue(agent) },
      channel: { findMany: jest.fn().mockResolvedValue([{ id: '1' }, { id: '2' }, { id: '3' }]) },
      aiAgentChannel: { createMany: jest.fn() },
    };
    const service = new AgentsService(prisma as any);
    expect(await service.create('org-1', { name: 'Agente' } as any)).toEqual(agent);
    expect(prisma.aiAgentChannel.createMany).not.toHaveBeenCalled();
  });
});
