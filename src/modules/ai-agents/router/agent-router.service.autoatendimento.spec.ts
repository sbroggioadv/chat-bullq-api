import { AgentRouterService } from './agent-router.service';

describe('AgentRouterService — autoatendimento', () => {
  let prisma: any;
  let service: AgentRouterService;
  let conversation: any;
  let cards: any[];
  let agents: any[];
  let org: any;

  beforeEach(() => {
    cards = [];
    agents = [];
    org = { id: 'org-1', aiEnabled: true, aiPanicMode: false, aiBusinessHours: null, aiMonthlyTokenCap: null };
    conversation = { id: 'c1', organizationId: 'org-1', channelId: 'ch1', aiEnabled: null, activeAgentId: null, isGroup: false };
    prisma = {
      organization: { findUnique: jest.fn(async () => org) },
      channel: { findUnique: jest.fn().mockResolvedValue({ aiEnabled: null }) },
      card: { findMany: jest.fn(async ({ where }: any) => cards.filter(c => c.conversationId === where.conversationId && c.status === where.status)) },
      aiAgent: {
        findFirst: jest.fn(async ({ where }: any) => agents.find(a => a.organizationId === where.organizationId && a.isActive && !a.deletedAt && a.pipelineScope.some((p: string) => where.pipelineScope.hasSome.includes(p))) ?? null),
        findMany: jest.fn(async ({ where }: any) => agents.filter(a => a.organizationId === where.organizationId && a.isActive && !a.deletedAt && (!where.pipelineScope || a.pipelineScope.some((p: string) => where.pipelineScope.hasSome.includes(p))))) },
      aiAgentChannel: { findFirst: jest.fn().mockResolvedValue({ id: 'link' }) },
      aiAgentRun: { aggregate: jest.fn() },
    };
    service = new AgentRouterService(prisma, {} as any, {} as any);
  });
  const scope = () => {
    cards.push({ conversationId: 'c1', status: 'OPEN', pipelineId: 'p1' });
    agents.push({ id: 'scoped', organizationId: 'org-1', isActive: true, deletedAt: null, pipelineScope: ['p1'] });
  };
  it('bloqueia conversa sem ativação ou pipeline', async () => {
    expect(await service.shouldHandle(conversation)).toEqual({ handle: false, reason: 'AUTOATENDIMENTO_OFF' });
  });
  it('atende conversa ativada e com vínculo', async () => {
    conversation.aiEnabled = true;
    expect(await service.shouldHandle(conversation)).toEqual({ handle: true });
  });
  it('atende conversa com agente ativo', async () => {
    conversation.activeAgentId = 'a1'; conversation.aiEnabled = true;
    expect(await service.shouldHandle(conversation)).toEqual({ handle: true });
  });
  it('atende card aberto com pipeline no escopo', async () => {
    scope();
    expect(await service.shouldHandle(conversation)).toEqual({ handle: true, scopedAgentIds: ['scoped'] });
  });
  it('organização desligada bloqueia mesmo com pipeline no escopo', async () => {
    scope(); org.aiEnabled = false;
    expect(await service.shouldHandle(conversation)).toEqual({ handle: false, reason: 'org.aiEnabled=false' });
  });
  it.each([true, false])('organização desligada bloqueia override da conversa %s', async (enabled) => {
    org.aiEnabled = false; conversation.aiEnabled = enabled;
    expect((await service.shouldHandle(conversation)).handle).toBe(false);
  });
  it('conversa desativada bloqueia mesmo com agente e pipeline', async () => {
    scope(); conversation.aiEnabled = false; conversation.activeAgentId = 'a1';
    expect(await service.shouldHandle(conversation)).toEqual({ handle: false, reason: 'conversation.aiEnabled=force-off' });
  });
  it('grupo sem ativação é bloqueado', async () => {
    conversation.isGroup = true; conversation.aiAllowedInGroup = false;
    expect(await service.shouldHandle(conversation)).toEqual({ handle: false, reason: 'GROUP_AI_OFF' });
  });
  it('card fechado ou de pipeline não correspondente não habilita', async () => {
    scope(); cards[0].status = 'WON';
    expect(await service.shouldHandle(conversation)).toEqual({ handle: false, reason: 'AUTOATENDIMENTO_OFF' });
    cards[0].status = 'OPEN'; cards[0].pipelineId = 'p2';
    expect(await service.shouldHandle(conversation)).toEqual({ handle: false, reason: 'AUTOATENDIMENTO_OFF' });
  });
  it('agente ativo sozinho não habilita a conversa', async () => {
    conversation.activeAgentId = 'a1';
    expect(await service.shouldHandle(conversation)).toEqual({ handle: false, reason: 'AUTOATENDIMENTO_OFF' });
  });
  it('escopo exige vínculo AUTONOMOUS do agente escopado', async () => {
    scope();
    prisma.aiAgentChannel.findFirst.mockImplementation(async ({ where }: any) =>
      where.agent?.id ? null : { id: 'other-link' });
    expect(await service.shouldHandle(conversation)).toEqual({ handle: false, reason: 'no-agent-for-channel' });
  });
  it('seleciona agente escopado em vez do outro agente do canal, inclusive com agente anterior', async () => {
    scope(); conversation.activeAgentId = 'outro';
    prisma.aiAgent.findUnique = jest.fn().mockResolvedValue({ id: 'outro', name: 'Outro' });
    prisma.aiAgentChannel.findFirst.mockImplementation(async ({ where }: any) =>
      where.agent?.id?.in?.includes('scoped') ? { agent: { id: 'scoped', name: 'Escopado' } } : { agent: { id: 'outro', name: 'Outro' } });
    expect((await service.shouldHandle(conversation)).handle).toBe(true);
    expect((await service.selectAgent(conversation, 'oi'))?.agentId).toBe('scoped');
  });
  it('prefere o agente ativo quando está escopado e vinculado ao canal', async () => {
    scope();
    agents.push({ id: 's2', organizationId: 'org-1', isActive: true, deletedAt: null, pipelineScope: ['p1'] });
    conversation.activeAgentId = 's2';
    prisma.aiAgentChannel.findFirst.mockImplementation(async ({ where }: any) =>
      ({ agent: where.agent.id === 's2' ? { id: 's2', name: 'Segundo' } : { id: 'scoped', name: 'Primeiro' } }));
    expect((await service.selectAgent(conversation, 'oi'))?.agentId).toBe('s2');
  });
  it('sem agente ativo elegível seleciona pelo vínculo mais antigo e id como desempate', async () => {
    scope();
    agents.push({ id: 's2', organizationId: 'org-1', isActive: true, deletedAt: null, pipelineScope: ['p1'] });
    conversation.activeAgentId = 'outro';
    prisma.aiAgentChannel.findFirst.mockImplementation(async ({ orderBy }: any) => ({
      agent: orderBy ? { id: 'scoped', name: 'Primeiro' } : { id: 's2', name: 'Segundo' },
    }));
    expect((await service.selectAgent(conversation, 'oi'))?.agentId).toBe('scoped');
    expect(prisma.aiAgentChannel.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }));
  });
  it('grupo permitido é bloqueado com organização desligada', async () => {
    org.aiEnabled = false; conversation.isGroup = true; conversation.aiAllowedInGroup = true;
    expect(await service.shouldHandle(conversation, { content: 'oi' })).toEqual({ handle: false, reason: 'org.aiEnabled=false' });
  });

});
