import { AgentRouterService } from './agent-router.service';

describe('catálogo de workers por organização', () => {
  it('exclui agente alheio e mantém agente do canal', async () => {
    const links = ['org-a', 'org-b'].map(organizationId => ({ agent: { organizationId, name: organizationId, description: null, department: null, capabilities: [] } }));
    const findMany = jest.fn(async ({ where }: any) => links.filter(l => !where.agent.organizationId || l.agent.organizationId === where.agent.organizationId));
    const svc = Object.create(AgentRouterService.prototype) as any;
    svc.prisma = { aiAgentChannel: { findMany } };
    const result = await svc.loadChannelWorkerCatalog('canal-b', 'org-b');
    expect(result.map((entry: any) => entry.name)).toEqual(['org-b']);
  });
});
