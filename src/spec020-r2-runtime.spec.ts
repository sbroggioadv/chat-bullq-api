/* QA probe (fora da worktree): fila 15 min, agente escolhido, Redis, devolução. */
import { GroupNoReplyProcessor, GroupNoReplyService } from './modules/ai-agents/runner/group-no-reply.service';
import { AiAgentRunnerService } from './modules/ai-agents/runner/agent-runner.service';
import { PromptBuilderService } from './modules/ai-agents/runner/prompt-builder.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentRouterService } = require('./modules/ai-agents/router/agent-router.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { InboundMessageProcessor } = require('./modules/messaging/pipeline/inbound-message.processor');

const guard = { runGuarded: (_id: string, fn: () => Promise<any>) => fn() };
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
function realRouterPrisma(conversation: any, latest: any) {
  return {
    conversation: { findUnique: jest.fn().mockResolvedValue(conversation) },
    message: { findFirst: jest.fn().mockResolvedValue(latest) },
    organization: { findUnique: jest.fn().mockImplementation(({ select }: any) => Promise.resolve(select ? { aiPanicMode: false } : { id: 'o', aiEnabled: true, aiMonthlyTokenCap: null })) },
    channel: { findUnique: jest.fn().mockResolvedValue({ type: 'WHATSAPP', aiEnabled: true }) },
    aiAgentChannel: { findFirst: jest.fn().mockResolvedValue({ agent: { id: 'orq', kind: 'ORCHESTRATOR', canRespondDirectly: true } }) },
  };
}
const group = (extra: any = {}) => ({ id: 'c', organizationId: 'o', channelId: 'ch', isGroup: true, isArchived: false, aiAllowedInGroup: true, aiEnabled: null, activeAgentId: null, ...extra });

describe('fila 15 min — última mensagem', () => {
  it.each([
    ['eco do próprio número', { id: 'eco', direction: 'OUTBOUND', type: 'TEXT' }],
    ['resposta da IA', { id: 'ia', direction: 'OUTBOUND', type: 'TEXT', senderId: null }],
    ['outro membro', { id: 'outro', direction: 'INBOUND', type: 'TEXT' }],
    ['reação', { id: 'r', direction: 'INBOUND', type: 'REACTION' }],
  ])('%s depois da mensagem → não roda', async (_n, latest) => {
    const prisma = realRouterPrisma(group(), latest);
    const runner = { run: jest.fn() };
    await new GroupNoReplyProcessor(prisma as any, new AgentRouterService(prisma as any, {} as any, {} as any), runner as any, guard as any)
      .process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
    expect(runner.run).not.toHaveBeenCalled();
    expect(prisma.message.findFirst.mock.calls[0][0]).toEqual({ where: { conversationId: 'c' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  });
  it('mensagem revogada não dispara', async () => {
    const prisma = realRouterPrisma(group(), { id: 'm', direction: 'INBOUND', type: 'TEXT', revokedAt: new Date() });
    const runner = { run: jest.fn() };
    await new GroupNoReplyProcessor(prisma as any, new AgentRouterService(prisma as any, {} as any, {} as any), runner as any, guard as any)
      .process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
    expect(runner.run).not.toHaveBeenCalled();
  });
  it('pânico ligado no disparo → não roda (gate real)', async () => {
    const prisma = realRouterPrisma(group(), { id: 'm', direction: 'INBOUND', type: 'TEXT' });
    prisma.organization.findUnique = jest.fn().mockResolvedValue({ aiPanicMode: true });
    const runner = { run: jest.fn() };
    await new GroupNoReplyProcessor(prisma as any, new AgentRouterService(prisma as any, {} as any, {} as any), runner as any, guard as any)
      .process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
    expect(runner.run).not.toHaveBeenCalled();
  });
  it('canal desligado no disparo → não roda (gate real)', async () => {
    const prisma = realRouterPrisma(group(), { id: 'm', direction: 'INBOUND', type: 'TEXT' });
    prisma.channel.findUnique = jest.fn().mockResolvedValue({ type: 'WHATSAPP', aiEnabled: false });
    const runner = { run: jest.fn() };
    await new GroupNoReplyProcessor(prisma as any, new AgentRouterService(prisma as any, {} as any, {} as any), runner as any, guard as any)
      .process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
    expect(runner.run).not.toHaveBeenCalled();
  });
  it('conversa (grupo) com IA forçada off no disparo → não roda', async () => {
    const prisma = realRouterPrisma(group({ aiEnabled: false }), { id: 'm', direction: 'INBOUND', type: 'TEXT' });
    const runner = { run: jest.fn() };
    await new GroupNoReplyProcessor(prisma as any, new AgentRouterService(prisma as any, {} as any, {} as any), runner as any, guard as any)
      .process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('fila 15 min — quem roda', () => {
  it('grupo com AGENTE ESCOLHIDO (setActiveAgent: activeAgentId=esp, aiEnabled=true, interruptor off) → usa o escolhido', async () => {
    const prisma = realRouterPrisma(group({ aiAllowedInGroup: false, aiEnabled: true, activeAgentId: 'esp' }), { id: 'm', direction: 'INBOUND', type: 'TEXT' });
    const runner = { run: jest.fn() };
    await new GroupNoReplyProcessor(prisma as any, new AgentRouterService(prisma as any, {} as any, {} as any), runner as any, guard as any)
      .process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ forcedAgentId: 'esp', persistActiveAgent: false }));
  });
  it('runner não substitui agente e não consome cota em NO_ACTION', async () => {
    const orq = { id: 'orq', name: 'O', kind: 'ORCHESTRATOR', canRespondDirectly: true, modelId: 'x', maxTokens: 2048 };
    const svc = Object.create(AiAgentRunnerService.prototype) as any;
    const convUpdate = jest.fn().mockResolvedValue({});
    svc.prisma = { aiAgent: { findFirst: jest.fn().mockResolvedValue(orq) }, organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, contact: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, message: { findMany: jest.fn().mockResolvedValue([]) }, aiAgentMemory: { findUnique: jest.fn().mockResolvedValue(null) }, aiAgentRun: { create: jest.fn().mockResolvedValue({ id: 'r' }), update: jest.fn() }, aiResponseLog: { create: jest.fn().mockResolvedValue({}) }, conversation: { update: convUpdate, findUnique: jest.fn() } };
    svc.agentRouter = { selectAgent: jest.fn() };
    svc.cadence = { evaluate: jest.fn().mockResolvedValue({ shouldSend: true, delayMs: 0 }) };
    svc.catalogSync = { getCompactCatalog: jest.fn().mockResolvedValue([]) };
    svc.mediaUrlResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
    svc.promptBuilder = { buildMessages: jest.fn().mockReturnValue([{ role: 'user', content: 'x' }]) };
    svc.resolveToolsAndSkills = jest.fn().mockResolvedValue({ llmTools: [], customSkillsByName: new Map(), skillInstructions: [] });
    svc.augmentSystemPromptWithLayers = jest.fn(); svc.scheduleAfterRunJobs = jest.fn().mockResolvedValue(undefined);
    svc.realtime = { emitToConversation: jest.fn() }; svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
    svc.llmRouter = { prepare: jest.fn().mockResolvedValue({ provider: 'T', modelId: 't', complete: jest.fn().mockResolvedValue({ message: { content: '' }, stopReason: 'stop', usage }) }) };
    svc.registry = { get: jest.fn() };
    await svc.run({ conversation: { id: 'c', organizationId: 'o', channelId: 'ch', contactId: 'ct', isGroup: true, activeAgentId: 'esp' }, triggerMessage: { id: 'm', content: '' }, forcedAgentId: 'esp', persistActiveAgent: false, expectedLatestMessageId: 'm', contextNote: 'nota' });
    expect(svc.agentRouter.selectAgent).not.toHaveBeenCalled();
    expect(svc.prisma.aiAgent.findFirst).toHaveBeenCalledWith({ where: { id: 'esp', organizationId: 'o', isActive: true, deletedAt: null } });
    expect(convUpdate).not.toHaveBeenCalled();
    expect(svc.prisma.aiResponseLog.create).not.toHaveBeenCalled();
  });
});

describe('agendamento na entrada — falha/lentidão do Redis', () => {
  const mk = (schedule: jest.Mock) => {
    const p = Object.create(InboundMessageProcessor.prototype);
    p.prisma = { conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c', isGroup: true }) }, message: { findUnique: jest.fn().mockResolvedValue({ id: 'm', type: 'TEXT', content: 'oi' }) } };
    p.agentRouter = { shouldHandle: jest.fn().mockResolvedValue({ handle: true }) };
    p.groupNoReply = { schedule }; p.scheduleAgentRun = jest.fn();
    p.realtimeGateway = { emitToConversation: jest.fn() }; p.logger = { debug: jest.fn(), error: jest.fn() };
    return p;
  };
  it('queue.add rejeita → erro registrado e resposta imediata agendada', async () => {
    const p = mk(jest.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await p.tryAiAgent('c', 'm');
    expect(p.logger.error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    expect(p.scheduleAgentRun).toHaveBeenCalledTimes(1);
  });
  it('queue.add pendurado não atrasa resposta imediata', async () => {
    const p = mk(jest.fn().mockReturnValue(new Promise(() => undefined)));
    void p.tryAiAgent('c', 'm');
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    expect(p.scheduleAgentRun).toHaveBeenCalledTimes(1);
  });

});

describe('devolução encadeada — resposta dupla', () => {
  it('especialista chama handBack e depois replyToConversation na mesma vez → não encadeia outra resposta', async () => {
    const worker = { id: 'w', name: 'W', kind: 'WORKER', canRespondDirectly: true, modelId: 'x', maxTokens: 2048 };
    const svc = Object.create(AiAgentRunnerService.prototype) as any;
    svc.prisma = { aiAgent: { findFirst: jest.fn().mockResolvedValue(worker) }, organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, contact: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, message: { findMany: jest.fn().mockResolvedValue([]) }, aiAgentMemory: { findUnique: jest.fn().mockResolvedValue(null) }, aiAgentRun: { create: jest.fn().mockResolvedValue({ id: 'r' }), update: jest.fn() }, aiResponseLog: { create: jest.fn().mockResolvedValue({}) }, conversation: { update: jest.fn(), findUnique: jest.fn().mockResolvedValue({ id: 'c', organizationId: 'o', channelId: 'ch', contactId: 'ct', activeAgentId: null, isGroup: false }) }, aiAgentChannel: { findFirst: jest.fn().mockResolvedValue({ agent: { id: 'orq', kind: 'ORCHESTRATOR', canRespondDirectly: true } }) } };
    svc.agentRouter = { selectAgent: jest.fn().mockResolvedValue({ agentId: 'w' }) };
    svc.cadence = { evaluate: jest.fn().mockResolvedValue({ shouldSend: true, delayMs: 0 }) };
    svc.catalogSync = { getCompactCatalog: jest.fn().mockResolvedValue([]) };
    svc.mediaUrlResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
    svc.promptBuilder = { buildMessages: jest.fn().mockReturnValue([]) };
    svc.resolveToolsAndSkills = jest.fn().mockResolvedValue({ llmTools: [], customSkillsByName: new Map(), skillInstructions: [] });
    svc.augmentSystemPromptWithLayers = jest.fn(); svc.scheduleAfterRunJobs = jest.fn().mockResolvedValue(undefined);
    svc.realtime = { emitToConversation: jest.fn() }; svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const complete = jest.fn().mockResolvedValueOnce({ message: { content: '', toolCalls: [{ id: '1', name: 'handBackToOrchestrator', arguments: {} }, { id: '2', name: 'replyToConversation', arguments: { text: 'oi' } }] }, stopReason: 'tool_calls', usage })
      .mockResolvedValue({ message: { content: '' }, stopReason: 'stop', usage });
    svc.llmRouter = { prepare: jest.fn().mockResolvedValue({ provider: 'T', modelId: 't', complete }) };
    svc.registry = { get: jest.fn() };
    svc.executeToolCalls = jest.fn().mockResolvedValue([
      { toolName: 'handBackToOrchestrator', toolCallId: '1', output: { ok: true }, finalAction: 'HANDED_BACK' },
      { toolName: 'replyToConversation', toolCallId: '2', output: { ok: true }, finalAction: 'REPLIED' },
    ]);
    const original = svc.run.bind(svc);
    svc.run = jest.fn().mockImplementationOnce(original).mockResolvedValue(undefined);
    await svc.run({ conversation: { id: 'c', organizationId: 'o', channelId: 'ch', contactId: 'ct', isGroup: false }, triggerMessage: { id: 'm', content: '' } });
    expect(svc.prisma.aiAgentRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ finalAction: 'HANDED_BACK' }) }));
    expect(svc.run).toHaveBeenCalledTimes(1);
  });
});


describe('injeção dos providers', () => {
  it('exporta e injeta GroupNoReplyService no processor de entrada', () => {
    const { AiAgentsModule } = require('./modules/ai-agents/ai-agents.module');
    const exports = Reflect.getMetadata('exports', AiAgentsModule);
    const params = Reflect.getMetadata('design:paramtypes', InboundMessageProcessor);
    expect(exports).toContain(GroupNoReplyService);
    expect(params).toContain(GroupNoReplyService);
  });
  it('resolve o serviço pelo container Nest no processor de entrada', async () => {
    const { Test } = require('@nestjs/testing');
    const { getQueueToken } = require('@nestjs/bullmq');
    const params = Reflect.getMetadata('design:paramtypes', InboundMessageProcessor);
    const explicit = Reflect.getMetadata('self:paramtypes', InboundMessageProcessor) || [];
    const tokens = params.map((token: any, index: number) => explicit.find((entry: any) => entry.index === index)?.param ?? token);
    const unique = [...new Set(tokens.filter((token: any) => token && token !== GroupNoReplyService))];
    const module = await Test.createTestingModule({ providers: [
      InboundMessageProcessor,
      GroupNoReplyService,
      ...unique.map((token: any) => ({ provide: token, useValue: {} })),
      { provide: getQueueToken('ai-group-no-reply'), useValue: {} },
    ] }).compile();
    const processor = module.get(InboundMessageProcessor) as any;
    expect(processor.groupNoReply).toBe(module.get(GroupNoReplyService));
    await module.close();
  });
});
