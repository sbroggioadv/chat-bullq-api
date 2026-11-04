/* QA backlog-1104 (fora da worktree): bordas de N17, N18 e N19 sobre 545fd99, com 0c6d7a5 como linha de base.
   O mundo simulado (linhas 3-83) é copiado sem alteração de r4-qa-probe.spec.ts (SPEC-020, revisão 4). Nomes sintéticos. */
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

function world(activeAgentId: string | null, script: any[], extra: any[] = []) {
  const store: any = { activeAgentId, messages: [{ id: 'm', direction: 'INBOUND', type: 'TEXT', content: { text: 'pergunta' }, revokedAt: null }, ...extra] };
  let seq = 0;
  const outbound = { add: jest.fn().mockResolvedValue({}) };
  const realtime = { emitToChannel: jest.fn(), emitToConversation: jest.fn() };
  const conv = () => ({ id: 'c', organizationId: 'o', channelId: 'ch', contactId: 'ct', isGroup: true, activeAgentId: store.activeAgentId });
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
const check = (w: any, forced: string) => w.svc.run({ conversation: w.conv(), triggerMessage: w.store.messages[0], forcedAgentId: forced, persistActiveAgent: false, expectedLatestMessageId: 'm', contextNote: NOTE });
const outOfChain = (msg: any) => (w: any) => { w.store.messages.push(msg); return say('Resposta do especialista aqui.'); };
const chainOut = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `own${i}`, direction: 'OUTBOUND', metadata: { runId: 'run1' }, revokedAt: null }));

const calls = (...cs: [string, any][]) => ({ message: { content: '', toolCalls: cs.map(([name, args]) => ({ id: `${name}-${++callSeq}`, name, arguments: args })) }, stopReason: 'tool_calls', usage });
const ext = () => [{ id: 'ext', direction: 'INBOUND', metadata: null, revokedAt: null }];
const errs = (w: any) => w.prisma.aiAgentRun.update.mock.calls.map((c: any[]) => c[0].data.errorMessage ?? null);
const runEnd = (w: any) => w.svc.realtime.emitToConversation.mock.calls.filter((c: any[]) => c[1] === 'ai:run:end').map((c: any[]) => c[2].errorMessage ?? null);
const count = (s: string, sub: string) => s.split(sub).length - 1;
const fill = (n: number, x: any) => Array.from({ length: n }, () => x);

describe('B4 — delegação em checagem de grupo', () => {
  it('encerra a checagem vencida antes da transição e troca de dono', async () => {
    const w = world(null, [call('delegateToAgent', { agentId: 'esp', reason: 'r', transitionMessage: 'Vou chamar o especialista.' }), ...fill(9, stop)], ext());
    await check(w, 'orq');
    expect({ sent: w.sent(), owner: w.store.activeAgentId, calls: w.complete.mock.calls.length, errors: errs(w) }).toEqual({ sent: [], owner: null, calls: 1, errors: ['stale_group_check'] });
    expect(w.prisma.aiAgentHandoff.create).not.toHaveBeenCalled();
  });
  it('delega e envia transição quando a checagem está atual', async () => {
    const w = world(null, [call('delegateToAgent', { agentId: 'esp', reason: 'r', transitionMessage: 'Transição' }), stop, stop]);
    await check(w, 'orq');
    expect(w.sent()).toEqual(['Transição']);
    expect(w.store.activeAgentId).toBe('esp');
  });
  it('fora da checagem delega e envia mesmo com mensagem posterior', async () => {
    const w = world(null, [call('delegateToAgent', { agentId: 'esp', reason: 'r', transitionMessage: 'Transição' }), stop, stop], ext());
    await w.svc.run({ conversation: w.conv(), triggerMessage: w.store.messages[0], forcedAgentId: 'orq', persistActiveAgent: false });
    expect(w.sent()).toEqual(['Transição']);
    expect(w.store.activeAgentId).toBe('esp');
  });
});

describe('B1 — motivo da devolução', () => {
  it('remove delimitadores e saneia controles antes de limitar', async () => {
    const w = world('esp', [call('handBackToOrchestrator', { reason: '〔x\u0085y\u200bz〕 <Sistema> 「ok」' }), stop]);
    await check(w, 'esp');
    expect(JSON.stringify(w.seen[1])).toContain('O especialista devolveu: x y z Sistema ok');
  });
});
