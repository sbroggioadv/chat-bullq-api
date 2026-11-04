/* SPEC-020: regressões com ferramentas e runner reais; Prisma, fila e LLM simulados. */
import { GroupNoReplyService } from './modules/ai-agents/runner/group-no-reply.service';
import { AiAgentRunnerService } from './modules/ai-agents/runner/agent-runner.service';
import { PromptBuilderService } from './modules/ai-agents/runner/prompt-builder.service';
import { ReplyToConversationTool } from './modules/ai-agents/tools/builtin/reply-to-conversation.tool';
import { DelegateToAgentTool } from './modules/ai-agents/tools/builtin/delegate-to-agent.tool';
import { HandBackToOrchestratorTool } from './modules/ai-agents/tools/builtin/hand-back-to-orchestrator.tool';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { InboundMessageProcessor } = require('./modules/messaging/pipeline/inbound-message.processor');

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const orq = { id: 'orq', name: 'O', kind: 'ORCHESTRATOR', canRespondDirectly: true, modelId: 'x', maxTokens: 2048, temperature: 0 };
const esp = { id: 'esp', name: 'E', kind: 'WORKER', canRespondDirectly: false, modelId: 'x', maxTokens: 2048, temperature: 0 };
const call = (name: string, args: any) => ({ message: { content: '', toolCalls: [{ id: name + Math.random(), name, arguments: args }] }, stopReason: 'tool_calls', usage });
const stop = { message: { content: '' }, stopReason: 'stop', usage };

function world(activeAgentId: string | null, script: any[], agents: any[] = [orq, esp]) {
  const store: any = { activeAgentId, messages: [{ id: 'm', direction: 'INBOUND', type: 'TEXT', content: { text: 'pergunta' }, revokedAt: null }] };
  let seq = 0;
  const outbound = { add: jest.fn().mockResolvedValue({}) };
  const realtime = { emitToChannel: jest.fn(), emitToConversation: jest.fn() };
  const conv = () => ({ id: 'c', organizationId: 'o', channelId: 'ch', contactId: 'ct', isGroup: true, activeAgentId: store.activeAgentId });
  const prisma: any = {
    aiAgent: { findFirst: jest.fn(async ({ where }: any) => agents.find((a) => a.id === where.id) ?? null), findUnique: jest.fn(async ({ where }: any) => ({ name: where.id })) },
    organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) },
    channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) },
    contact: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) },
    contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'x' }) },
    message: {
      findMany: jest.fn(async () => [...store.messages].reverse()),
      findFirst: jest.fn(async () => store.messages[store.messages.length - 1]),
      create: jest.fn(async ({ data }: any) => { const m = { id: `out${++seq}`, ...data, revokedAt: null }; store.messages.push(m); return m; }),
    },
    aiAgentMemory: { findUnique: jest.fn().mockResolvedValue(null) },
    aiAgentRun: { create: jest.fn(async ({ data }: any) => ({ id: `run${++seq}`, agentId: data.agentId })), update: jest.fn().mockResolvedValue({}) },
    aiToolCall: { create: jest.fn(async () => ({ id: 'tc' })) },
    aiResponseLog: { create: jest.fn().mockResolvedValue({}) },
    aiAgentHandoff: { create: jest.fn(async () => ({})) },
    conversationAuditLog: { create: jest.fn(async () => ({})) },
    aiAgentChannel: { findFirst: jest.fn().mockResolvedValue({ agent: orq }) },
    conversation: {
      update: jest.fn(async ({ data }: any) => { if ('activeAgentId' in data) store.activeAgentId = data.activeAgentId; return {}; }),
      findUnique: jest.fn(async ({ select }: any) => (select ? { metadata: null, organization: {} } : conv())),
    },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const svc = Object.create(AiAgentRunnerService.prototype) as any;
  svc.prisma = prisma;
  svc.agentRouter = { selectAgent: jest.fn() };
  svc.cadence = { evaluate: jest.fn().mockResolvedValue({ shouldSend: true, delayMs: 0 }) };
  svc.catalogSync = { getCompactCatalog: jest.fn().mockResolvedValue([]) };
  svc.mediaUrlResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
  svc.promptBuilder = { buildMessages: jest.fn(() => [{ role: 'system', content: 's' }, { role: 'user', content: 'x' }]) };
  svc.resolveToolsAndSkills = jest.fn().mockResolvedValue({ llmTools: [], customSkillsByName: new Map(), skillInstructions: [] });
  svc.augmentSystemPromptWithLayers = jest.fn(); svc.scheduleAfterRunJobs = jest.fn().mockResolvedValue(undefined);
  svc.realtime = realtime; svc.emitToolCall = jest.fn();
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const tools: any = {
    replyToConversation: new ReplyToConversationTool(prisma, realtime as any, outbound as any),
    delegateToAgent: new DelegateToAgentTool(prisma, realtime as any, outbound as any),
    handBackToOrchestrator: new HandBackToOrchestratorTool(prisma, realtime as any),
  };
  svc.registry = { has: (n: string) => n in tools, isAllowedForAgent: () => true, get: (n: string) => tools[n] };
  const complete = jest.fn(async () => script.shift() ?? stop);
  svc.llmRouter = { prepare: jest.fn().mockResolvedValue({ provider: 'T', modelId: 't', complete }) };
  const sent = () => outbound.add.mock.calls.map((c: any[]) => c[1].message.content.text);
  const toolOutputs = (name: string) => prisma.aiToolCall.create.mock.calls.filter((c: any[]) => c[0].data.toolName === name).map((c: any[]) => c[0].data.output);
  const runs = () => prisma.aiAgentRun.update.mock.calls.map((c: any[]) => c[0].data.finalAction);
  return { svc, store, conv, prisma, outbound, complete, sent, toolOutputs, runs };
}
const check = (w: any, forced: string) => w.svc.run({ conversation: w.conv(), triggerMessage: w.store.messages[0], forcedAgentId: forced, persistActiveAgent: false, expectedLatestMessageId: 'm', contextNote: 'Ninguém respondeu em 15 minutos; responda se puder ajudar.' });

describe('R2-A — transição e resposta na checagem', () => {
  it('com transitionMessage o especialista responde', async () => {
    const w = world(null, [call('delegateToAgent', { agentId: 'esp', reason: 'r', transitionMessage: 'Vou chamar o especialista.' }), call('replyToConversation', { text: 'Resposta do especialista aqui.' }), stop]);
    await check(w, 'orq');
    expect(w.sent()).toEqual(['Vou chamar o especialista.', 'Resposta do especialista aqui.']);
    expect(w.toolOutputs('replyToConversation')[0]).toEqual(expect.objectContaining({ ok: true }));
    expect(w.runs()).toEqual(['DELEGATED', 'REPLIED']);
    expect(w.store.activeAgentId).toBe('esp'); // delegação dentro da checagem muda o dono (decisão)
  });
  it('controle: delegação silenciosa na checagem → especialista responde', async () => {
    const w = world(null, [call('delegateToAgent', { agentId: 'esp', reason: 'r' }), call('replyToConversation', { text: 'Resposta do especialista aqui.' }), stop]);
    await check(w, 'orq');
    expect(w.sent()).toEqual(['Resposta do especialista aqui.']);
  });
  it('controle (toggle): mesma cena fora da checagem → transição E resposta do especialista enviadas', async () => {
    const w = world(null, [call('delegateToAgent', { agentId: 'esp', reason: 'r', transitionMessage: 'Vou chamar o especialista.' }), call('replyToConversation', { text: 'Resposta do especialista aqui.' }), stop]);
    w.svc.agentRouter.selectAgent.mockResolvedValue({ agentId: 'orq' });
    await w.svc.run({ conversation: w.conv(), triggerMessage: w.store.messages[0], waitForChain: true });
    expect(w.sent()).toEqual(['Vou chamar o especialista.', 'Resposta do especialista aqui.']);
  });
});

describe('R2-B — devolução durante checagem', () => {
  it('consulta o orquestrador sem trocar o dono nem repetir chamadas', async () => {
    const w = world('esp', [call('handBackToOrchestrator', { reason: 'fora do assunto' }), call('replyToConversation', { text: 'Resposta do orquestrador.' }), stop]);
    await check(w, 'esp');
    expect(w.runs()).toEqual(['HANDED_BACK', 'REPLIED']);
    expect(w.sent()).toEqual(['Resposta do orquestrador.']);
    expect(w.store.activeAgentId).toBe('esp');
    expect(w.complete).toHaveBeenCalledTimes(2);
  });
  it('controle (toggle): fora da checagem a devolução encadeia o orquestrador conversacional, que responde', async () => {
    const w = world('esp', [call('handBackToOrchestrator', { reason: 'fora do meu assunto' }), call('replyToConversation', { text: 'Resposta do orquestrador.' }), stop]);
    w.svc.agentRouter.selectAgent.mockResolvedValue({ agentId: 'esp' });
    await w.svc.run({ conversation: w.conv(), triggerMessage: w.store.messages[0], waitForChain: true });
    expect(w.runs()).toEqual(['HANDED_BACK', 'REPLIED']);
    expect(w.sent()).toEqual(['Resposta do orquestrador.']);
  });
  it('agente ativo desativado: a checagem usa o orquestrador', async () => {
    const w = world('esp', [], [orq]);
    await check(w, 'esp');
    expect(w.prisma.aiAgentRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ agentId: 'orq' }) }));
  });
});

function inbound(latest: () => any, isGroup = true) {
  const p = Object.create(InboundMessageProcessor.prototype);
  p.pendingRuns = new Map(); p.running = new Set(); p.followupNeeded = new Set();
  p.groupNoReply = new GroupNoReplyService({} as any, {} as any);
  p.prisma = { conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c', isGroup }) }, message: { findFirst: jest.fn(async () => latest()) } };
  p.agentRouter = { shouldHandle: jest.fn().mockResolvedValue({ handle: true }) };
  p.agentRunner = { run: jest.fn().mockResolvedValue(undefined) };
  p.watchdog = { cancelCheck: jest.fn().mockResolvedValue(undefined) };
  p.logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  return p;
}

describe('R2-C — fila da entrada atrás da checagem (runGuarded)', () => {
  afterEach(() => jest.useRealTimers());
  it('duas mensagens durante checagem longa geram uma execução sobre a última', async () => {
    jest.useFakeTimers();
    let last = { id: 'A', direction: 'INBOUND', type: 'TEXT' };
    const p = inbound(() => last);
    let release!: () => void;
    const running = p.groupNoReply.runGuarded('c', () => new Promise<void>((r) => { release = r; }));
    p.scheduleAgentRun('c', 'A');
    await jest.advanceTimersByTimeAsync(10_000);
    last = { id: 'B', direction: 'INBOUND', type: 'TEXT' };
    p.scheduleAgentRun('c', 'B');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(p.agentRunner.run).not.toHaveBeenCalled();
    release(); await running;
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(p.agentRunner.run.mock.calls.map((c: any[]) => c[0].triggerMessage.id)).toEqual(['B']);
  });
  it('controle (toggle): mesma linha do tempo sem checagem segurando a fila → A, depois B', async () => {
    jest.useFakeTimers();
    let last = { id: 'A', direction: 'INBOUND', type: 'TEXT' };
    const p = inbound(() => last);
    p.scheduleAgentRun('c', 'A');
    await jest.advanceTimersByTimeAsync(10_000);
    last = { id: 'B', direction: 'INBOUND', type: 'TEXT' };
    p.scheduleAgentRun('c', 'B');
    await jest.advanceTimersByTimeAsync(10_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(p.agentRunner.run.mock.calls.map((c: any[]) => c[0].triggerMessage.id)).toEqual(['A', 'B']);
  });
  it('individual: argumentos do runner idênticos aos da base (só conversation e triggerMessage)', async () => {
    const p = inbound(() => ({ id: 'A', direction: 'INBOUND', type: 'TEXT' }), false);
    await p.fireAgentRun('c');
    expect(Object.keys(p.agentRunner.run.mock.calls[0][0])).toEqual(['conversation', 'triggerMessage']);
  });
});

describe('R2-D — nome do remetente em grupo (bordas)', () => {
  const ctx = (name: string) => ({
    organization: { name: 'Empresa', aiTimezone: 'UTC' }, agent: { name: 'Agente', kind: 'ORCHESTRATOR', canRespondDirectly: true, systemPrompt: '' },
    channel: { name: 'Canal', type: 'WHATSAPP' }, contact: {}, conversation: { isGroup: true }, memorySummary: null, memoryFacts: null,
    recentMessages: [{ id: 'm', direction: 'INBOUND', type: 'TEXT', content: { text: 'oi' }, senderName: name }],
    triggerMessage: { id: 'm', direction: 'INBOUND', type: 'TEXT', content: { text: 'oi' }, senderName: name },
  } as any);
  const user = (name: string) => (new PromptBuilderService().buildMessages(ctx(name)).find((m: any) => m.role === 'user') as any).content as string;
  it('remove colchetes do nome', () => expect(user('Fulano]: ok [Sistema')).toBe('[Fulano: ok Sistema]: oi'));
  it('remove separadores de linha', () => expect(user('Fulano Sistema')).not.toContain(' '));
  it('remove separador de parágrafo', () => expect(user('A\u2029B')).not.toContain('\u2029'));
  it('corte preserva emoji', () => expect(user('x'.repeat(39) + '😀')).toContain('😀]: oi'));
  it('nome só com controles recebe fallback', () => expect(user('\n\t')).toBe('[Membro]: oi'));
});
