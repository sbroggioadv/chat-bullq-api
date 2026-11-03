import { AgentRouterService } from './agent-router.service';

describe('SPEC-018 — gate de grupo', () => {
  let org: any, channel: any, conversation: any, prisma: any, router: AgentRouterService;
  beforeEach(() => {
    org = { id: 'o', aiEnabled: true, aiPanicMode: false };
    channel = { aiEnabled: null };
    conversation = { id: 'c', organizationId: 'o', channelId: 'ch', isGroup: true, aiAllowedInGroup: true, aiEnabled: null, activeAgentId: null };
    prisma = { organization: { findUnique: jest.fn(async () => org) }, channel: { findUnique: jest.fn(async () => channel) }, aiAgent: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue({ id: 'a', name: 'Agente' }) } };
    router = new AgentRouterService(prisma, {} as any, {} as any);
  });
  it.each([[100, false], [99, true]])('grupo ligado com teto mensal usado=%s: atende=%s', async (used, handle) => {
    org.aiMonthlyTokenCap = 100;
    prisma.aiAgentRun = { aggregate: jest.fn().mockResolvedValue({ _sum: { inputTokens: used, outputTokens: 0 } }) };
    expect(await router.shouldHandle(conversation)).toEqual(handle ? { handle: true } : { handle: false, reason: 'monthly-token-cap-reached' });
  });
  it('interruptor ligado responde sem menção', async () => expect(await router.shouldHandle(conversation, { content: 'oi' })).toEqual({ handle: true }));
  it('agente escolhido habilita e é selecionado', async () => {
    Object.assign(conversation, { aiAllowedInGroup: false, activeAgentId: 'a', aiEnabled: true });
    expect(await router.shouldHandle(conversation)).toEqual({ handle: true });
    expect((await router.selectAgent(conversation, 'oi'))?.agentId).toBe('a');
  });
  it('sem agente escolhido segue classificador e orquestrador do canal', async () => {
    const classifier = { classify: jest.fn().mockResolvedValue({ intent: 'SMALL_TALK', confidence: 0.9, skippedOrchestrator: false, costUsd: 0 }) };
    prisma.aiAgentChannel = { findFirst: jest.fn().mockResolvedValue({ agent: { id: 'orch', name: 'Orquestrador' } }) };
    router = new AgentRouterService(prisma, classifier as any, {} as any);
    expect((await router.selectAgent(conversation, 'oi'))?.agentId).toBe('orch');
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(prisma.aiAgentChannel.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ channelId: 'ch', mode: 'AUTONOMOUS' }) }));
  });
  it.each([null, 'a'])('sem interruptor e agente %s sem ativação não atende', async (id) => {
    Object.assign(conversation, { aiAllowedInGroup: false, activeAgentId: id });
    expect(await router.shouldHandle(conversation)).toEqual({ handle: false, reason: 'GROUP_AI_OFF' });
  });
  it.each(['interruptor', 'agente'])('organização desligada bloqueia %s', async (mode) => {
    org.aiEnabled = false;
    if (mode === 'agente') Object.assign(conversation, { aiAllowedInGroup: false, activeAgentId: 'a', aiEnabled: true });
    expect(await router.shouldHandle(conversation)).toEqual({ handle: false, reason: 'org.aiEnabled=false' });
  });
  it('canal desligado bloqueia até agente escolhido', async () => {
    channel.aiEnabled = false; Object.assign(conversation, { activeAgentId: 'a', aiEnabled: true });
    expect(await router.shouldHandle(conversation)).toEqual({ handle: false, reason: 'channel.aiEnabled=force-off' });
  });
  it('pânico bloqueia grupo', async () => { org.aiPanicMode = true; expect(await router.shouldHandle(conversation)).toEqual({ handle: false, reason: 'ORG_PANIC_MODE' }); });
  it('conversa desligada prevalece sobre interruptor', async () => { conversation.aiEnabled = false; expect(await router.shouldHandle(conversation)).toEqual({ handle: false, reason: 'conversation.aiEnabled=force-off' }); });
});
