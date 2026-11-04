import { AiAgentRunnerService } from './modules/ai-agents/runner/agent-runner.service';
import { ReplyToConversationTool } from './modules/ai-agents/tools/builtin/reply-to-conversation.tool';
import { DelegateToAgentTool } from './modules/ai-agents/tools/builtin/delegate-to-agent.tool';
import { HandBackToOrchestratorTool } from './modules/ai-agents/tools/builtin/hand-back-to-orchestrator.tool';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const orq = { id: 'orq', name: 'O', kind: 'ORCHESTRATOR', canRespondDirectly: true, modelId: 'x', maxTokens: 2048, temperature: 0 };
const esp = { id: 'esp', name: 'E', kind: 'WORKER', canRespondDirectly: false, modelId: 'x', maxTokens: 2048, temperature: 0 };
let callSeq = 0;
const call = (name: string, args: any) => ({ message: { content: '', toolCalls: [{ id: `${name}-${++callSeq}`, name, arguments: args }] }, stopReason: 'tool_calls', usage });
const say = (text: string) => ({ message: { content: text }, stopReason: 'stop', usage });
const stop = { message: { content: '' }, stopReason: 'stop', usage };
const NOTE = 'Ninguém respondeu em 15 minutos; responda se puder ajudar.';

function world(activeAgentId: string | null, script: any[], extra: any[] = [], group = true) {
  const store: any = { activeAgentId, messages: [{ id: 'm', direction: 'INBOUND', type: 'TEXT', content: { text: 'pergunta' }, revokedAt: null }, ...extra] };
  let seq = 0;
  const outbound = { add: jest.fn().mockResolvedValue({}) };
  const realtime = { emitToChannel: jest.fn(), emitToConversation: jest.fn() };
  const conv = () => ({ id: 'c', organizationId: 'o', channelId: 'ch', contactId: 'ct', isGroup: group, activeAgentId: store.activeAgentId });
  const agents = [orq, esp];
  const prisma: any = {
    aiAgent: { findFirst: jest.fn(async ({ where }: any) => agents.find((a) => a.id === where.id) ?? null), findUnique: jest.fn(async ({ where }: any) => ({ name: where.id })) },
    organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) },
    channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) },
    contact: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) },
    contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'x' }) },
    message: {
      findMany: jest.fn(async (args: any) => [...store.messages].reverse().slice(0, args.take)),
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
  const replyTool = new ReplyToConversationTool(prisma, realtime as any, outbound as any);
  const replyCtx: any[] = [];
  const replyOut: any[] = [];
  const origReply = replyTool.execute.bind(replyTool);
  (replyTool as any).execute = async (input: any, ctx: any) => { replyCtx.push({ keys: Object.keys(ctx), json: JSON.stringify(ctx) }); const r = await origReply(input, ctx); replyOut.push(r.output); return r; };
  const tools: any = {
    replyToConversation: replyTool,
    delegateToAgent: new DelegateToAgentTool(prisma, realtime as any, outbound as any),
    handBackToOrchestrator: new HandBackToOrchestratorTool(prisma, realtime as any),
  };
  svc.registry = { has: (n: string) => n in tools, isAllowedForAgent: () => true, get: (n: string) => tools[n] };
  const seen: string[] = [];
  const w: any = { svc, store, conv, prisma, outbound, seen, replyCtx, replyOut };
  const complete = jest.fn(async (args: any) => { seen.push(JSON.stringify(args.messages)); const next = script.shift() ?? stop; return typeof next === 'function' ? next(w) : next; });
  svc.llmRouter = { prepare: jest.fn().mockResolvedValue({ provider: 'T', modelId: 't', complete }) };
  w.complete = complete;
  w.sent = () => outbound.add.mock.calls.map((c: any[]) => c[1].message.content.text);
  w.runs = () => prisma.aiAgentRun.update.mock.calls.map((c: any[]) => c[0].data.finalAction);
  w.runAgents = () => prisma.aiAgentRun.create.mock.calls.map((c: any[]) => c[0].data.agentId);
  w.reads = () => prisma.message.findMany.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.take !== 30);
  return w;
}

const run = (w: any, agent: string) => w.svc.run({ conversation: w.conv(), triggerMessage: w.store.messages[0], forcedAgentId: agent, persistActiveAgent: false, waitForChain: true });

describe('F1 ação terminal', () => {
  it('cena 2: devolve uma vez e encadeia o orquestrador uma vez', async () => {
    const w = world('esp', Array(9).fill(call('handBackToOrchestrator', { reason: 'motivo' })));
    w.complete.mockImplementation(async () => w.runAgents().length === 1 ? call('handBackToOrchestrator', { reason: 'motivo' }) : stop);
    await run(w, 'esp');
    expect(w.prisma.aiAgentHandoff.create).toHaveBeenCalledTimes(1);
    expect(w.runAgents()).toEqual(['esp', 'orq']);
    expect(w.complete).toHaveBeenCalledTimes(2);
  });
  it('cena 3: delega uma vez e encadeia o especialista uma vez', async () => {
    const w = world(null, Array(9).fill(call('delegateToAgent', { agentId: 'esp', reason: 'motivo' })));
    w.complete.mockImplementation(async () => w.runAgents().length === 1 ? call('delegateToAgent', { agentId: 'esp', reason: 'motivo' }) : stop);
    await run(w, 'orq');
    expect(w.prisma.aiAgentHandoff.create).toHaveBeenCalledTimes(1);
    expect(w.runAgents()).toEqual(['orq', 'esp']);
    expect(w.complete).toHaveBeenCalledTimes(2);
  });
});

describe('F2 delegação após resposta', () => {
  it('cena 4: resposta individual seguida de delegação encadeia o especialista', async () => {
    const w = world(null, [call('replyToConversation', { text: 'Vou chamar o especialista.' }), call('delegateToAgent', { agentId: 'esp', reason: 'motivo' }), stop], [], false);
    await run(w, 'orq');
    expect(w.sent()).toEqual(['Vou chamar o especialista.']);
    expect(w.runs()[0]).toBe('DELEGATED');
    expect(w.runAgents()).toEqual(['orq', 'esp']);
    expect(w.prisma.aiAgentHandoff.create).toHaveBeenCalledTimes(1);
  });
});
