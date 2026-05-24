import { AgentRouterService } from './agent-router.service';
import { GroupMentionDetector } from '../scope/group-mention-detector.service';

const makeDeps = () => {
  const agents: any[] = [];
  const cards: any[] = [];
  return {
    state: { agents, cards },
    prisma: {
      organization: { findUnique: jest.fn().mockResolvedValue({ id: 'org-1', aiEnabled: true, aiMonthlyTokenCap: null, aiBusinessHours: null, aiTimezone: 'America/Sao_Paulo' }) },
      channel: { findUnique: jest.fn().mockResolvedValue({ aiEnabled: null }) },
      aiAgent: {
        findMany: jest.fn(async ({ where }: any) =>
          agents.filter((a) => a.organizationId === where.organizationId && a.isActive && a.deletedAt === null)
        ),
        findUnique: jest.fn(async ({ where }: any) => agents.find((a) => a.id === where.id) ?? null),
      },
      aiAgentChannel: { findFirst: jest.fn().mockResolvedValue({ id: 'ac-1' }) },
      card: {
        findMany: jest.fn(async ({ where }: any) =>
          cards.filter((c) => c.conversationId === where.conversationId && c.status === 'OPEN')
        ),
      },
      aiAgentRun: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    },
    detector: {
      findMatchingAgent: jest.fn(),
    },
  };
};

describe('AgentRouterService — S22 scope extensions', () => {
  let deps: ReturnType<typeof makeDeps>;
  let svc: AgentRouterService;

  beforeEach(() => {
    deps = makeDeps();
    // Constructor real do router precisa de mais deps — usar `as any` no instanciamento
    svc = new AgentRouterService(
      deps.prisma as any,
      {} as any, // classifier
      {} as any, // catalog
      deps.detector as unknown as GroupMentionDetector,
    );
  });

  it('grupo sem aiAllowedInGroup → handle=false, reason=GROUP_NOT_WHITELISTED', async () => {
    const conv = {
      id: 'c1', organizationId: 'org-1', channelId: 'ch-1',
      isGroup: true, aiAllowedInGroup: false, aiEnabled: null, activeAgentId: null,
    };
    const r = await svc.shouldHandle(conv as any, { content: { text: 'oi' } } as any);
    expect(r.handle).toBe(false);
    expect(r.reason).toBe('GROUP_NOT_WHITELISTED');
  });

  it('grupo whitelist ON + sem @ nem reply → handle=false, GROUP_NO_MENTION', async () => {
    deps.detector.findMatchingAgent.mockResolvedValueOnce(null);
    deps.state.agents.push({ id: 'a1', organizationId: 'org-1', isActive: true, deletedAt: null, mentionHandle: 'vendas', pipelineScope: [] });
    const conv = {
      id: 'c1', organizationId: 'org-1', channelId: 'ch-1',
      isGroup: true, aiAllowedInGroup: true, aiEnabled: null, activeAgentId: null,
    };
    const r = await svc.shouldHandle(conv as any, { content: { text: 'oi' } } as any);
    expect(r.handle).toBe(false);
    expect(r.reason).toBe('GROUP_NO_MENTION');
  });

  it('grupo whitelist ON + match detector → handle=true', async () => {
    const agent = { id: 'a1', organizationId: 'org-1', isActive: true, deletedAt: null, mentionHandle: 'vendas', pipelineScope: [] };
    deps.state.agents.push(agent);
    deps.detector.findMatchingAgent.mockResolvedValueOnce(agent);
    const conv = {
      id: 'c1', organizationId: 'org-1', channelId: 'ch-1',
      isGroup: true, aiAllowedInGroup: true, aiEnabled: null, activeAgentId: null,
    };
    const r = await svc.shouldHandle(conv as any, { content: { text: '@vendas oi' } } as any);
    expect(r.handle).toBe(true);
  });

  it('1-on-1 com conversation.activeAgentId → bypassa pipeline scope', async () => {
    const agent = { id: 'a1', organizationId: 'org-1', isActive: true, deletedAt: null, pipelineScope: [] };
    deps.state.agents.push(agent);
    const conv = {
      id: 'c1', organizationId: 'org-1', channelId: 'ch-1',
      isGroup: false, aiEnabled: null, activeAgentId: 'a1',
    };
    const r = await svc.shouldHandle(conv as any, { content: { text: 'oi' } } as any);
    expect(r.handle).toBe(true);
  });

  it('1-on-1 + pipeline scope match → handle=true', async () => {
    const agent = { id: 'a1', organizationId: 'org-1', isActive: true, deletedAt: null, pipelineScope: ['p1'] };
    deps.state.agents.push(agent);
    deps.state.cards.push({ conversationId: 'c1', status: 'OPEN', pipelineId: 'p1' });
    deps.prisma.card.findMany.mockImplementationOnce(async () => deps.state.cards);
    const conv = {
      id: 'c1', organizationId: 'org-1', channelId: 'ch-1',
      isGroup: false, aiEnabled: null, activeAgentId: null,
    };
    const r = await svc.shouldHandle(conv as any, { content: { text: 'oi' } } as any);
    expect(r.handle).toBe(true);
  });
});
