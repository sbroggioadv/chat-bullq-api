/* SPEC-020 R4: runner e ferramentas reais com dependências simuladas. */
import { AiAgentRunnerService } from './modules/ai-agents/runner/agent-runner.service';
import { ReplyToConversationTool } from './modules/ai-agents/tools/builtin/reply-to-conversation.tool';
import { DelegateToAgentTool } from './modules/ai-agents/tools/builtin/delegate-to-agent.tool';
import { HandBackToOrchestratorTool } from './modules/ai-agents/tools/builtin/hand-back-to-orchestrator.tool';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const orq = { id: 'orq', name: 'O', kind: 'ORCHESTRATOR', canRespondDirectly: true, modelId: 'x', maxTokens: 2048, temperature: 0 };
const esp = { id: 'esp', name: 'E', kind: 'WORKER', canRespondDirectly: false, modelId: 'x', maxTokens: 2048, temperature: 0 };
const call = (name: string, args: any) => ({ message: { content: '', toolCalls: [{ id: name + Math.random(), name, arguments: args }] }, stopReason: 'tool_calls', usage });
const say = (text: string) => ({ message: { content: text }, stopReason: 'stop', usage });
const stop = { message: { content: '' }, stopReason: 'stop', usage };
const NOTE = 'Ninguém respondeu em 15 minutos; responda se puder ajudar.';

function world(activeAgentId: string | null, script: any[], agents: any[] = [orq, esp], extra: any[] = []) {
  const store: any = { activeAgentId, messages: [{ id: 'm', direction: 'INBOUND', type: 'TEXT', content: { text: 'pergunta' }, revokedAt: null }, ...extra] };
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
  const tools: any = {
    replyToConversation: new ReplyToConversationTool(prisma, realtime as any, outbound as any),
    delegateToAgent: new DelegateToAgentTool(prisma, realtime as any, outbound as any),
    handBackToOrchestrator: new HandBackToOrchestratorTool(prisma, realtime as any),
  };
  svc.registry = { has: (n: string) => n in tools, isAllowedForAgent: () => true, get: (n: string) => tools[n] };
  const seen: { agent: string; messages: string }[] = [];
  const complete = jest.fn(async (args: any) => { seen.push({ agent: args.modelId, messages: JSON.stringify(args.messages) }); return script.shift() ?? stop; });
  svc.llmRouter = { prepare: jest.fn().mockResolvedValue({ provider: 'T', modelId: 't', complete }) };
  const sent = () => outbound.add.mock.calls.map((c: any[]) => c[1].message.content.text);
  const toolOutputs = (name: string) => prisma.aiToolCall.create.mock.calls.filter((c: any[]) => c[0].data.toolName === name).map((c: any[]) => c[0].data.output);
  const runs = () => prisma.aiAgentRun.update.mock.calls.map((c: any[]) => c[0].data.finalAction);
  const runAgents = () => prisma.aiAgentRun.create.mock.calls.map((c: any[]) => c[0].data.agentId);
  return { svc, store, conv, prisma, outbound, complete, seen, sent, toolOutputs, runs, runAgents };
}
const check = (w: any, forced: string) => w.svc.run({ conversation: w.conv(), triggerMessage: w.store.messages[0], forcedAgentId: forced, persistActiveAgent: false, expectedLatestMessageId: 'm', contextNote: NOTE });
const normal = (w: any, routed: string) => { w.svc.agentRouter.selectAgent.mockResolvedValue({ agentId: routed }); return w.svc.run({ conversation: w.conv(), triggerMessage: w.store.messages[0], waitForChain: true }); };

describe('SPEC-020 R4', () => {
  const scene = (transition: boolean, tool: boolean) => [
    call('delegateToAgent', { agentId: 'esp', reason: 'motivo', ...(transition ? { transitionMessage: 'Vou chamar o especialista.' } : {}) }), stop,
    tool ? call('replyToConversation', { text: 'Resposta do especialista aqui.' }) : say('Resposta do especialista aqui.'), stop,
  ];
  it('R3-1: transição e texto solto são enviados na checagem', async () => {
    const w = world(null, scene(true, false)); await check(w, 'orq');
    expect(w.sent()).toEqual(['Vou chamar o especialista.', 'Resposta do especialista aqui.']);
  });
  it.each([[false, false], [true, true]])('controle na checagem: transição=%s ferramenta=%s', async (transition, tool) => {
    const w = world(null, scene(transition, tool)); await check(w, 'orq');
    expect(w.sent()).toEqual(transition ? ['Vou chamar o especialista.', 'Resposta do especialista aqui.'] : ['Resposta do especialista aqui.']);
  });
  it('controle fora da checagem envia transição e texto', async () => {
    const w = world(null, scene(true, false)); await normal(w, 'orq');
    expect(w.sent()).toEqual(['Vou chamar o especialista.', 'Resposta do especialista aqui.']);
  });
  it('R3-2: consulta limitada seleciona somente os campos necessários', async () => {
    const w = world(null, [call('replyToConversation', { text: 'Resposta.' }), stop]); await check(w, 'orq');
    expect(w.prisma.message.findMany).toHaveBeenCalledWith({ where: { conversationId: 'c' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20, select: { id: true, direction: true, metadata: true, revokedAt: true } });
  });
  it('R3-2: mensagem esperada fora da janela vence a checagem', async () => {
    const extra = Array.from({ length: 20 }, (_, i) => ({ id: `out${i}`, direction: 'OUTBOUND', metadata: { runId: 'run1' }, revokedAt: null }));
    const w = world(null, [call('replyToConversation', { text: 'Resposta.' }), stop], [orq, esp], extra); await check(w, 'orq');
    expect(w.toolOutputs('replyToConversation')).toEqual([{ ok: false, error: 'stale_group_check' }]);
  });
  it.each([
    { id: 'h', direction: 'OUTBOUND', metadata: {}, revokedAt: null },
    { id: 'o', direction: 'OUTBOUND', metadata: { runId: 'outra' }, revokedAt: null },
  ])('controle: saída externa vence a checagem', async (msg) => {
    const w = world(null, [call('replyToConversation', { text: 'Resposta.' }), stop], [orq, esp], [msg]); await check(w, 'orq');
    expect(w.toolOutputs('replyToConversation')).toEqual([{ ok: false, error: 'stale_group_check' }]);
  });
  it('controle: mensagem esperada revogada vence a checagem', async () => {
    const w = world(null, [call('replyToConversation', { text: 'Resposta.' }), stop]); w.store.messages[0].revokedAt = new Date(); await check(w, 'orq');
    expect(w.toolOutputs('replyToConversation')).toEqual([{ ok: false, error: 'stale_group_check' }]);
  });
  it('N13: consulta recebe nota da checagem e motivo do especialista', async () => {
    const w = world('esp', [call('handBackToOrchestrator', { reason: 'pergunta de pagamento' }), stop]); await check(w, 'esp');
    expect(w.runAgents()).toEqual(['esp', 'orq']);
    expect(w.seen[1].messages).toContain(NOTE);
    expect(w.seen[1].messages).toContain('O especialista devolveu: pergunta de pagamento');
  });
});
