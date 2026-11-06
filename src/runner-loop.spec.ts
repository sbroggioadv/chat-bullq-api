import { AiProvider } from '@prisma/client';
import { AiLlmRouterService } from './modules/ai-agents/providers/ai-llm-router.service';
import { OpenAiCompatibleAdapter } from './modules/ai-agents/providers/openai-compatible.adapter';
import { FuguLlmAdapter } from './modules/ai-agents/providers/fugu-llm.adapter';
import { QwenLlmAdapter } from './modules/ai-agents/providers/qwen-llm.adapter';
import { TEAM_PROMISE_PROMPT } from './modules/ai-agents/runner/team-promise';
import { TransferToHumanTool } from './modules/ai-agents/tools/builtin/transfer-to-human.tool';
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
const NOTE = 'Ninguém respondeu em 15 minutos; responda só se for um pedido em que você possa ajudar. Cumprimento solto e conversa entre os membros continuam sem resposta.';

function world(activeAgentId: string | null, script: any[], extra: any[] = [], group = true) {
  const store: any = { aiEnabled: null, activeAgentId, messages: [{ id: 'm', direction: 'INBOUND', type: 'TEXT', content: { text: 'pergunta' }, revokedAt: null }, ...extra] };
  let seq = 0;
  const outbound = { add: jest.fn().mockResolvedValue({}) };
  const realtime = { emitToChannel: jest.fn(), emitToConversation: jest.fn() };
  const conv = () => ({ id: 'c', organizationId: 'o', channelId: 'ch', contactId: 'ct', isGroup: group, aiEnabled: store.aiEnabled, assignedToId: store.assignedToId ?? null, activeAgentId: store.activeAgentId });
  const agents = [orq, esp];
  const prisma: any = {
    aiAgent: { findFirst: jest.fn(async ({ where }: any) => agents.find((a) => a.id === where.id) ?? null), findUnique: jest.fn(async ({ where }: any) => ({ name: where.id })) },
    organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({}), findUnique: jest.fn(async () => ({ settings: store.settings })) },
    userOrganization: { findFirst: jest.fn().mockResolvedValue({ userId: 'responsavel' }) },
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
      findFirst: jest.fn(async () => ({ ...conv(), contact: { name: 'Grupo sintético' } })),
      updateMany: jest.fn(async ({ where, data }: any) => { if (where.OR && store.aiEnabled === false) return { count: 0 }; Object.assign(store, data); return { count: 1 }; }),
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
  const pending = { create: jest.fn().mockResolvedValue({ id: 'pending' }) };
  const action = { execute: jest.fn().mockResolvedValue({ output: { ok: true } }) };
  const groupNotify = { notifyGroupByJid: jest.fn().mockResolvedValue({ sent: true }) };
  const notifications = { notify: jest.fn().mockResolvedValue({}) };
  const tools: any = {
    transferToHuman: new (TransferToHumanTool as any)(realtime, pending, prisma, groupNotify, notifications),
    tagConversation: action, grantAccess: action, listAvailableAgents: action,
    replyToConversation: replyTool,
    delegateToAgent: new DelegateToAgentTool(prisma, realtime as any, outbound as any),
    handBackToOrchestrator: new HandBackToOrchestratorTool(prisma, realtime as any),
  };
  svc.registry = { has: (n: string) => n in tools, isAllowedForAgent: () => true, get: (n: string) => tools[n] };
  const seen: string[] = [];
  const w: any = { svc, store, conv, prisma, outbound, groupNotify, notifications, seen, replyCtx, replyOut, pending, action, tools };
  const checkComplete = jest.fn(async (args: any) => say(args.messages[1].content.includes(TEAM_PROMISE) ? 'SIM' : 'NAO'));
  const complete = jest.fn(async (args: any) => { seen.push(JSON.stringify(args.messages)); const next = script.shift() ?? stop; return typeof next === 'function' ? next(w) : next; });
  const providerComplete = jest.fn((args: any) => args.messages[0]?.content === TEAM_PROMISE_PROMPT && !('tools' in args) ? checkComplete(args) : complete(args));
  svc.llmRouter = { prepare: jest.fn().mockResolvedValue({ provider: 'T', modelId: 't', complete: providerComplete }), completeWithProvider: jest.fn((_provider: any, args: any) => checkComplete(args)) };
  w.checkComplete = checkComplete; w.providerComplete = providerComplete;
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
  it('cena 4: resposta individual seguida de delegação é bloqueada', async () => {
    const w = world(null, [call('replyToConversation', { text: 'Vou chamar o especialista.' }), call('delegateToAgent', { agentId: 'esp', reason: 'motivo' }), stop], [], false);
    await run(w, 'orq');
    expect(w.sent()).toEqual(['Vou chamar o especialista.']);
    expect(w.runs()[0]).toBe('REPLIED');
    expect(w.store.activeAgentId).toBeNull();
    expect(w.runAgents()).toEqual(['orq']);
    expect(w.prisma.aiAgentHandoff.create).not.toHaveBeenCalled();
    expect(w.prisma.aiToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ error: 'delegate-after-reply-blocked', output: { ok: false, error: 'delegate_after_reply' } }) }));
  });
});

describe('F3 resposta de grupo', () => {
  it('cena 1: responde e não consulta modelo nem altera o dono novamente', async () => {
    const w = world('orq', [call('replyToConversation', { text: 'Atendemos hoje.' }), { message: { content: '', toolCalls: [{ id: 'list', name: 'listAvailableAgents', arguments: {} }, { id: 'delegate', name: 'delegateToAgent', arguments: { agentId: 'esp', reason: 'antigo' } }] }, stopReason: 'tool_calls', usage }]);
    await run(w, 'orq');
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.store.activeAgentId).toBe('orq');
    expect(w.runs()).toEqual(['REPLIED']);
    expect(w.runAgents()).toEqual(['orq']);
    expect(w.prisma.aiAgentHandoff.create).not.toHaveBeenCalled();
  });
  it('individual bloqueia segunda resposta com erro brando', async () => {
    const w = world('orq', [call('replyToConversation', { text: 'Primeira resposta.' }), call('replyToConversation', { text: 'Segunda resposta.' }), stop], [], false);
    await run(w, 'orq');
    expect(w.sent()).toEqual(['Primeira resposta.']);
    expect(w.complete).toHaveBeenCalledTimes(3);
    expect(w.seen[2]).toContain('Already replied this turn.');
    expect(w.prisma.aiToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ error: 'duplicate-reply-blocked', output: expect.objectContaining({ ok: false, error: 'Already replied this turn. Do NOT call replyToConversation again — wait for the customer to react. End the turn now (you may still tag/handBack/transfer if needed).' }) }) }));
  });
  it('grupo não executa delegação que acompanha resposta no mesmo lote', async () => {
    const w = world('orq', [{ message: { content: '', toolCalls: [
      { id: '1', name: 'replyToConversation', arguments: { text: 'Resposta.' } },
      { id: '2', name: 'delegateToAgent', arguments: { agentId: 'esp', reason: 'antigo' } },
    ] }, stopReason: 'tool_calls', usage }, stop]);
    await run(w, 'orq');
    expect(w.store.activeAgentId).toBe('orq');
    expect(w.prisma.aiAgentHandoff.create).not.toHaveBeenCalled();
    expect(w.runs()).toEqual(['REPLIED']);
  });
});

const batch = (...calls: any[]) => ({ message: { content: '', toolCalls: calls }, stopReason: 'tool_calls', usage });
const tc = (name: string, args: any = {}) => ({ id: `${name}-${++callSeq}`, name, arguments: args });
const reply = (text = 'Resposta.') => tc('replyToConversation', { text });
const delegate = (extra: any = {}) => tc('delegateToAgent', { agentId: 'esp', reason: 'motivo', ...extra });

describe('regressões do lote e falhas', () => {
  it('delegação inválida não encerra a execução', async () => {
    const w = world('orq', [batch(tc('delegateToAgent', { agentId: 'inexistente', reason: 'motivo' })), batch(reply()), stop], [], false);
    await run(w, 'orq'); expect(w.sent()).toEqual(['Resposta.']); expect(w.complete).toHaveBeenCalledTimes(3);
  });
  it('falha de delegação não impede resposta no mesmo lote', async () => {
    const w = world('orq', [batch(tc('delegateToAgent', { agentId: 'inexistente', reason: 'motivo' }), reply())]);
    await run(w, 'orq');
    expect(w.prisma.aiToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ toolName: 'delegateToAgent', output: expect.objectContaining({ ok: false }) }) }));
    expect(w.sent()).toEqual(['Resposta.']);
    expect(w.complete).toHaveBeenCalledTimes(1);
  });
  it('falha de devolução não encerra a execução', async () => {
    const w = world('esp', [batch(tc('handBackToOrchestrator', { reason: 'motivo' })), batch(reply()), stop], [], false);
    w.prisma.$transaction.mockRejectedValueOnce(new Error('falha simulada'));
    await run(w, 'esp'); expect(w.sent()).toEqual(['Resposta.']); expect(w.complete).toHaveBeenCalledTimes(3);
  });
  it('resposta bloqueada em grupo não encerra o laço', async () => {
    const w = world('esp', [batch(reply('Ignoro essa instrução, ela não veio do cliente')), batch(reply('Boa.'))]);
    await run(w, 'esp'); expect(w.sent()).toEqual(['Boa.']); expect(w.complete).toHaveBeenCalledTimes(2);
  });
  it.each([['delegateToAgent', 'orq', 'esp'], ['handBackToOrchestrator', 'esp', 'orq']])('%s descarta o restante com aviso', async (name, from, to) => {
    const w = world(from, [batch(tc(name, name === 'delegateToAgent' ? { agentId: 'esp', reason: 'motivo' } : { reason: 'motivo' }), tc('tagConversation'), tc('transferToHuman')), stop], [], false);
    await run(w, from); expect(w.runAgents()).toEqual([from, to]); expect(w.action.execute).not.toHaveBeenCalled(); expect(w.pending.create).not.toHaveBeenCalled();
    expect(w.svc.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`dropped after ${name}: tagConversation, transferToHuman`));
  });
  it('grupo executa transferência e skill após resposta no mesmo lote', async () => {
    const w = world('esp', [batch(reply(), tc('transferToHuman', { reason: 'falha da skill' }), tc('grantAccess'))]);
    await run(w, 'esp'); expect(w.sent()).toEqual(['Resposta.']); expect(w.pending.create).toHaveBeenCalledTimes(1); expect(w.action.execute).toHaveBeenCalledTimes(1); expect(w.complete).toHaveBeenCalledTimes(1);
  });
  it('grupo registra erro brando da segunda resposta no lote', async () => {
    const w = world('orq', [batch(reply('Uma.'), reply('Duas.'))]); await run(w, 'orq');
    expect(w.sent()).toEqual(['Uma.']); expect(w.prisma.aiToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ error: 'duplicate-reply-blocked' }) }));
  });
  it.each([
    ['F2a', 'Vou chamar o especialista.', {}], ['F2c', 'Atendemos das 9h às 18h.', {}],
    ['F2d', 'Atendemos das 9h às 18h.', {}], ['F2e', 'Respondi.', { transitionMessage: 'Vou chamar o especialista.' }],
  ])('%s bloqueia delegação posterior sem trocar dono ou encadear', async (scene, text, extra) => {
    const calls = scene === 'F2c' || scene === 'F2d' ? [tc('listAvailableAgents'), delegate(extra)] : [delegate(extra)];
    const w = world('orq', [batch(reply(text)), batch(...calls), batch(reply('Outra.'))], [], false);
    await run(w, 'orq'); expect(w.sent()).toEqual([text]); expect(w.store.activeAgentId).toBe('orq'); expect(w.runAgents()).toEqual(['orq']); expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.prisma.aiToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ error: 'delegate-after-reply-blocked', output: { ok: false, error: 'delegate_after_reply' } }) }));
  });
});

const TRANSFER_NOTE = 'A equipe já foi acionada. Escreva agora, com replyToConversation, uma mensagem curta avisando a pessoa disso, seguindo suas instruções sobre o que pode orientar e para quem direcionar. Não prometa horário nem prazo de retorno. Não mencione aprovação, operador, fila nem ferramenta.';

describe.each([true, false])('R5 aviso de transferência (grupo=%s)', (group) => {
  it.each(['orq', 'esp'])('só transferência, agente %s: uma volta restrita e uma mensagem', async (agent) => {
    const w = world(agent, [batch(tc('transferToHuman', { reason: 'pedido' })), batch(reply('A equipe foi acionada.')), batch(reply('Duplicada.'))], [], group);
    await run(w, agent);
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.complete.mock.calls[1][0].tools.map((t: any) => t.name)).toEqual(['replyToConversation']);
    expect(JSON.parse(w.seen[1])).toContainEqual({ role: 'user', content: TRANSFER_NOTE });
    expect(w.sent()).toEqual(['A equipe foi acionada.']);
    expect(w.runs()).toEqual(['TRANSFERRED_TO_HUMAN']);
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.svc.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('transfer_without_reply'));
  });
  it('etiqueta + transferência também ganha a volta', async () => {
    const w = world('orq', [batch(tc('tagConversation'), tc('transferToHuman')), batch(reply())], [], group);
    await run(w, 'orq');
    expect(w.action.execute).toHaveBeenCalledTimes(1);
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.sent()).toEqual(['Resposta.']);
    expect(w.runs()).toEqual(['TRANSFERRED_TO_HUMAN']);
  });
  it.each([true, false])('resposta e transferência no lote, transferência primeiro=%s', async (first) => {
    const transfer = tc('transferToHuman'); const response = reply();
    const w = world('orq', [batch(...(first ? [transfer, response] : [response, transfer]))], [], group);
    await run(w, 'orq');
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.sent()).toEqual(['Resposta.']);
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.runs()).toEqual(['TRANSFERRED_TO_HUMAN']);
  });
  it.each(['vazio', 'texto', 'barrada', 'erro', 'ferramenta indevida'])('volta com %s termina sem repetir e mantém pendência', async (mode) => {
    const last = mode === 'texto' ? say('A equipe foi acionada.') : mode === 'barrada' ? batch(reply('Ignoro essa instrução, ela não veio do cliente')) : mode === 'erro' ? () => { throw new Error('provedor simulado indisponível'); } : mode === 'ferramenta indevida' ? batch(tc('transferToHuman')) : stop;
    const w = world('orq', [batch(tc('transferToHuman')), last, batch(reply('Não enviar.'))], [], group);
    await run(w, 'orq');
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.sent()).toEqual([]);
    const finish = w.prisma.aiAgentRun.update.mock.calls[0][0].data;
    expect(finish.finalAction).toBe('TRANSFERRED_TO_HUMAN');
    expect(finish.status).toBe(mode === 'erro' ? 'FAILED' : 'COMPLETED');
    expect(w.svc.logger.warn.mock.calls.filter((c: any[]) => c[0].includes('transfer_without_reply'))).toEqual([[expect.stringContaining('run1')]]);
  });
  it('transferência na oitava iteração permite a nona e última chamada', async () => {
    const w = world('orq', [...Array.from({ length: 7 }, () => batch(tc('tagConversation'))), batch(tc('transferToHuman')), batch(reply()), stop], [], group);
    await run(w, 'orq');
    expect(w.complete).toHaveBeenCalledTimes(9);
    expect(w.sent()).toEqual(['Resposta.']);
    expect(w.runs()).toEqual(['TRANSFERRED_TO_HUMAN']);
  });
  it('transferência falha não recebe volta nem aviso de transferência sem resposta', async () => {
    const w = world('esp', [batch(tc('transferToHuman')), stop], [], group);
    w.pending.create.mockRejectedValue(new Error('falha definitiva simulada'));
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    await run(w, 'esp');
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.seen.join('')).not.toContain(TRANSFER_NOTE);
    expect(w.runs()).toEqual(['NO_ACTION']);
    expect(w.svc.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('transfer_without_reply'));
  });
  it.each(['delegateToAgent', 'handBackToOrchestrator'])('transferência junto de %s bem-sucedida não ganha volta', async (name) => {
    const w = world(name === 'delegateToAgent' ? 'orq' : 'esp', [batch(tc('transferToHuman'), tc(name, { agentId: 'esp', reason: 'pedido' }))], [], group);
    await run(w, name === 'delegateToAgent' ? 'orq' : 'esp');
    expect(w.prisma.aiAgentHandoff.create).toHaveBeenCalledTimes(1);
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.sent()).toEqual([]);
  });
});

it('R5 resposta da volta impede a reexecução de 15 minutos pelo processor real', async () => {
  const { GroupNoReplyProcessor, GroupNoReplyService } = await import('./modules/ai-agents/runner/group-no-reply.service');
  const w = world('orq', [batch(tc('transferToHuman')), batch(reply())]);
  await run(w, 'orq');
  expect(w.store.messages[w.store.messages.length - 1].direction).toBe('OUTBOUND');
  const runner = { run: jest.fn() }; const router = { shouldHandle: jest.fn() };
  const guard = new GroupNoReplyService({} as any, w.prisma);
  const processor = new GroupNoReplyProcessor(w.prisma, router as any, runner as any, guard);
  await processor.process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
  expect(router.shouldHandle).not.toHaveBeenCalled();
  expect(runner.run).not.toHaveBeenCalled();
});

it('R5 ferramenta de transferência usa os textos aprovados sem promessa de tempo', async () => {
  const w = world('orq', []);
  const result = await w.tools.transferToHuman.execute({ reason: 'pedido sintético' }, { conversationId: 'c', agentId: 'orq', runId: 'r' });
  expect(result.output.message).toBe('Transferência registrada com sucesso. A equipe foi acionada e vai dar continuidade — fluxo padrão, não é erro.');
  expect(result.output.agent_should_say).toBe('Avise o cliente, com naturalidade, que a equipe foi acionada e vai dar continuidade. Não prometa horário nem prazo de retorno. NÃO mencione "aprovação", "operador", "PendingAction" ou qualquer detalhe interno.');
  expect(result.finalAction).toBe('TRANSFERRED_TO_HUMAN');
  expect(w.pending.create).toHaveBeenCalledTimes(1);
});

describe('R5 texto exclusivo do classificador', () => {
  it.each([
    ['objeto', { text: '  Pedido sintético para a equipe  ' }, 'Pedido sintético para a equipe', ''],
    ['string', '  Pedido sintético para a equipe  ', 'Pedido sintético para a equipe', 'Pedido sintético para a equipe'],
    ['lista', [{ text: ' Pedido sintético' }, { type: 'image' }, { text: ' para a equipe ' }], 'Pedido sintético para a equipe', 'Pedido sintético para a equipe'],
    ['objeto sem texto', { text: 123 }, '', ''],
    ['objeto com texto inválido', { text: [{ text: 'Não interpretar' }] }, '', ''],
  ])('%s chega ao selectAgent sem alterar os demais consumidores', async (_label, content, expected, legacy) => {
    const w = world('orq', [batch(reply())]);
    w.store.messages[0].content = content;
    w.svc.agentRouter.selectAgent.mockResolvedValue({ agentId: 'orq' });
    w.svc.memoryExtractorQueue = { add: jest.fn().mockResolvedValue({}) };
    w.svc.ragIndexerQueue = { add: jest.fn().mockResolvedValue({}) };
    w.svc.scheduleAfterRunJobs.mockImplementation((...args: any[]) => (AiAgentRunnerService.prototype as any).scheduleAfterRunJobs.apply(w.svc, args));
    await w.svc.run({ conversation: w.conv(), triggerMessage: w.store.messages[0], persistActiveAgent: false });
    expect(w.svc.agentRouter.selectAgent).toHaveBeenCalledWith(expect.anything(), expected, []);
    expect(w.svc.cadence.evaluate).toHaveBeenCalledWith('ch', 'c', expect.anything(), '', legacy);
    expect(w.svc.augmentSystemPromptWithLayers.mock.calls[0][5]).toBe(legacy);
    if (legacy) {
      expect(w.svc.ragIndexerQueue.add).toHaveBeenCalledWith('index_message', expect.objectContaining({ content: legacy }), expect.anything());
    } else {
      expect(w.svc.ragIndexerQueue.add).not.toHaveBeenCalled();
    }
  });
});


const TEAM_PROMISE = 'Sobre os documentos, como o prazo é amanhã, vou acionar a equipe agora pra te orientar o quanto antes.';
const NON_PROMISES = [
  'A equipe avalia cada caso individualmente. Me conta brevemente o que está acontecendo.',
  'Se quiser uma avaliação formal pelo escritório, posso te conectar com a Dra. Fulana nossa especialista.',
  'Sou o assistente do escritório, e o Dr. Fulano e a equipe acompanham tudo por aqui.',
  'Os honorários são definidos caso a caso, depois que o Dr. Fulano avalia sua situação na reunião inicial. Quer agendar uma conversa?',
  'O escritório não atua na área criminal. Mas posso te indicar um colega de confiança que trabalha com isso. Quer que eu faça essa indicação?',
  'De segunda a sexta, das 9h às 18h, horário de Brasília.',
  'Se preferir, posso pedir para a equipe te chamar.',
];
const transferRows = (w: any) => w.prisma.aiToolCall.create.mock.calls.map((c: any[]) => c[0].data).filter((d: any) => d.toolName === 'transferToHuman');

describe.each([true, false])('R6 promessa enviada (grupo=%s)', (group) => {
  it.each(['solto', 'ferramenta'])('%s cria uma pendência auditada após checagem', async (mode) => {
    const w = world('esp', [mode === 'solto' ? say(TEAM_PROMISE) : batch(reply(TEAM_PROMISE))], [], group);
    await run(w, 'esp');
    expect(w.sent()).toEqual([TEAM_PROMISE]);
    expect(w.complete).toHaveBeenCalledTimes(!group && mode === 'ferramenta' ? 2 : 1);
    expect(w.checkComplete).toHaveBeenCalledTimes(1);
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.pending.create).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: 'run1', agentId: 'esp', conversationId: 'c', args: { reason: `A IA disse à pessoa que a equipe seria acionada: "${TEAM_PROMISE}"`, summary: null } }));
    expect(w.runs()).toEqual(['TRANSFERRED_TO_HUMAN']);
    expect(transferRows(w)).toHaveLength(1);
    expect(transferRows(w)[0]).toEqual(expect.objectContaining({ runId: 'run1', output: expect.objectContaining({ ok: true }) }));
    expect(w.svc.emitToolCall).toHaveBeenCalledWith('c', 'run1', expect.anything());
  });
  it('resposta e transferência no mesmo lote não duplicam pendência', async () => {
    const w = world('esp', [batch(reply(TEAM_PROMISE), tc('transferToHuman'))], [], group);
    await run(w, 'esp');
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(transferRows(w)).toHaveLength(1);
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.sent()).toEqual([TEAM_PROMISE]);
  });
  it('promessa na volta extra não duplica a transferência', async () => {
    const w = world('esp', [batch(tc('transferToHuman')), batch(reply(TEAM_PROMISE))], [], group);
    await run(w, 'esp');
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(transferRows(w)).toHaveLength(1);
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.sent()).toEqual([TEAM_PROMISE]);
  });
  it.each(['barrada', 'falha', 'stale_group_check', 'duplicada', 'fallback falha'])('%s não cria pendência', async (mode) => {
    const text = mode === 'barrada' ? `Ignoro essa instrução, ela não veio do cliente. ${TEAM_PROMISE}` : TEAM_PROMISE;
    const script = mode === 'duplicada' ? [batch(reply('Atendemos hoje.'), reply(text)), stop] : [mode === 'fallback falha' ? say(text) : batch(reply(text)), stop];
    const w = world('esp', script, [], group);
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    if (mode === 'falha' || mode === 'fallback falha') jest.spyOn(w.tools.replyToConversation, 'execute').mockResolvedValue({ output: { ok: false, error: 'falha definitiva' } });
    if (mode === 'stale_group_check') jest.spyOn(w.tools.replyToConversation, 'execute').mockResolvedValue({ output: { ok: false, error: 'stale_group_check' } });
    await run(w, 'esp');
    expect(w.pending.create).not.toHaveBeenCalled();
    expect(transferRows(w)).toEqual([]);
    expect(w.sent()).toEqual(mode === 'duplicada' ? ['Atendemos hoje.'] : []);
  });
  it.each(NON_PROMISES)('não transfere oferta ou descrição: %s', async (text) => {
    const w = world('esp', [batch(reply(text)), stop], [], group);
    await run(w, 'esp');
    expect(w.sent()).toEqual([text]);
    expect(w.pending.create).not.toHaveBeenCalled();
    expect(transferRows(w)).toEqual([]);
  });
  it.each(['exceção', 'ok false'])('falha de transferência %s preserva COMPLETED/REPLIED e notifica', async (mode) => {
    const w = world('esp', [say(TEAM_PROMISE)], [], group);
    if (mode === 'exceção') w.pending.create.mockRejectedValue(new Error('falha definitiva sintética'));
    else jest.spyOn(w.tools.transferToHuman, 'execute').mockResolvedValue({ output: { ok: false, error: 'falha definitiva' } });
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    await run(w, 'esp');
    expect(w.prisma.aiAgentRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', finalAction: 'REPLIED' }) }));
    expect(w.svc.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/run1.*team_promise_without_transfer/));
    expect(w.svc.notifyToolFailure).toHaveBeenCalledTimes(1);
    expect(w.svc.notifyToolFailure).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ runId: 'run1' }), toolName: 'transferToHuman' }));
    expect(transferRows(w)).toHaveLength(1);
    expect(w.complete).toHaveBeenCalledTimes(1);
  });
});
it('R6 texto solto do orquestrador em grupo continua descartado', async () => {
  const w = world('orq', [say(TEAM_PROMISE)]);
  await run(w, 'orq');
  expect(w.sent()).toEqual([]);
  expect(w.pending.create).not.toHaveBeenCalled();
  expect(transferRows(w)).toEqual([]);
  expect(w.complete).toHaveBeenCalledTimes(1);
});
it('R6 motivo limita o texto enviado a 300 caracteres', async () => {
  const text = TEAM_PROMISE + ' orientação'.repeat(40);
  const w = world('esp', [say(text)]);
  await run(w, 'esp');
  expect(w.pending.create).toHaveBeenCalledWith(expect.objectContaining({ args: { reason: `A IA disse à pessoa que a equipe seria acionada: "${text.slice(0, 300)}"`, summary: null } }));
});

describe('R6 silêncio em grupo', () => {
  it.each(['orq', 'esp'])('vazio e espaços encerram %s sem resposta nem falha', async (agent) => {
    for (const text of ['', '   \n\t ']) {
      const w = world(agent, [batch(reply(text)), batch(reply('Não enviar.'))]);
      w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
      await run(w, agent);
      expect(w.sent()).toEqual([]);
      expect(w.complete).toHaveBeenCalledTimes(1);
      expect(w.runs()).toEqual(['NO_ACTION']);
      expect(w.prisma.aiToolCall.create).toHaveBeenCalledTimes(1);
      expect(w.prisma.aiToolCall.create).toHaveBeenCalledWith({ data: expect.objectContaining({ runId: 'run1', toolName: 'replyToConversation', output: { ok: true, silent: true }, error: undefined }) });
      expect(w.svc.emitToolCall).toHaveBeenCalledTimes(1);
      expect(w.svc.notifyToolFailure).not.toHaveBeenCalled();
      expect(w.store.messages).toHaveLength(1);
      expect(w.store.messages[0].direction).toBe('INBOUND');
    }
  });
  it.each([true, false])('vazio + transferência roda a volta (vazio primeiro=%s)', async (emptyFirst) => {
    const empty = reply(' '); const transfer = tc('transferToHuman');
    const w = world('orq', [batch(...(emptyFirst ? [empty, transfer] : [transfer, empty])), batch(reply('A equipe foi acionada.'))]);
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    await run(w, 'orq');
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.sent()).toEqual(['A equipe foi acionada.']);
    expect(w.runs()).toEqual(['TRANSFERRED_TO_HUMAN']);
    expect(w.svc.notifyToolFailure).not.toHaveBeenCalled();
    expect(w.svc.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('transfer_without_reply'));
  });
  it('vazio na volta mantém erro antigo e aviso, sem terceira consulta', async () => {
    const w = world('orq', [batch(tc('transferToHuman')), batch(reply('   ')), batch(reply('Não enviar.'))]);
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    await run(w, 'orq');
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.sent()).toEqual([]);
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.runs()).toEqual(['TRANSFERRED_TO_HUMAN']);
    expect(w.prisma.aiToolCall.create).toHaveBeenCalledWith({ data: expect.objectContaining({ toolName: 'replyToConversation', output: { ok: false, error: 'text is empty' } }) });
    expect(w.svc.logger.warn).toHaveBeenCalledWith('Run run1: transfer_without_reply');
    expect(w.svc.notifyToolFailure).toHaveBeenCalledTimes(1);
  });
  it.each(['orq', 'esp'])('individual mantém text is empty e permite nova consulta (%s)', async (agent) => {
    const w = world(agent, [batch(reply(' ')), batch(reply('Resposta.')), stop], [], false);
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    await run(w, agent);
    expect(w.sent()).toEqual(['Resposta.']);
    expect(w.complete).toHaveBeenCalledTimes(3);
    expect(w.prisma.aiToolCall.create).toHaveBeenCalledWith({ data: expect.objectContaining({ output: { ok: false, error: 'text is empty' } }) });
    expect(w.svc.notifyToolFailure).toHaveBeenCalledTimes(1);
  });
  it('silêncio não liga a trava de resposta nem bloqueia delegação no lote', async () => {
    const w = world('orq', [batch(reply(''), delegate()), batch(reply('Resposta do especialista.'))]);
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    await run(w, 'orq');
    expect(w.runAgents()).toEqual(['orq', 'esp']);
    expect(w.sent()).toEqual(['Resposta do especialista.']);
    expect(w.prisma.aiAgentHandoff.create).toHaveBeenCalledTimes(1);
    expect(w.runs()).toEqual(['DELEGATED', 'REPLIED']);
    expect(w.svc.notifyToolFailure).not.toHaveBeenCalled();
    expect(w.prisma.aiToolCall.create.mock.calls.some((c: any[]) => c[0].data.error === 'delegate-after-reply-blocked')).toBe(false);
  });
  it('silêncio não bloqueia resposta real no mesmo lote', async () => {
    const w = world('orq', [batch(reply(''), reply('Resposta.'))]);
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    await run(w, 'orq');
    expect(w.sent()).toEqual(['Resposta.']);
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.runs()).toEqual(['REPLIED']);
    expect(w.svc.notifyToolFailure).not.toHaveBeenCalled();
  });
  it('última mensagem segue INBOUND e processor de 15 minutos reexecuta como antes', async () => {
    const { GroupNoReplyProcessor, GroupNoReplyService } = await import('./modules/ai-agents/runner/group-no-reply.service');
    const w = world('orq', [batch(reply(''))]);
    await run(w, 'orq');
    expect(w.store.messages).toHaveLength(1);
    const runner = { run: jest.fn().mockResolvedValue(undefined) };
    const router = { shouldHandle: jest.fn().mockResolvedValue({ handle: true }) };
    const guard = new GroupNoReplyService({} as any, w.prisma);
    const processor = new GroupNoReplyProcessor(w.prisma, router as any, runner as any, guard);
    await processor.process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
    expect(router.shouldHandle).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ triggerMessage: w.store.messages[0], expectedLatestMessageId: 'm', forcedAgentId: 'orq', persistActiveAgent: false, contextNote: NOTE }));
  });
});

describe.each([true, false])('R7 erro pós-envio grupo=%s', (group) => {
  it.each([false, true])('auditoria falha; transferência falha=%s', async (fails) => {
    const w = world('esp', [batch(reply(TEAM_PROMISE))], [], group);
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    w.prisma.aiToolCall.create.mockRejectedValue(new Error('auditoria sintética'));
    if (fails) w.pending.create.mockRejectedValue(new Error('falha definitiva'));
    await expect(run(w, 'esp')).resolves.toBeUndefined();
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.sent()).toEqual([TEAM_PROMISE]);
    expect(w.prisma.aiAgentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', ...(!fails ? { finalAction: 'TRANSFERRED_TO_HUMAN' } : {}) }) }));
    if (fails) {
      expect(w.svc.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/run1.*team_promise_without_transfer/));
      expect(w.svc.notifyToolFailure).toHaveBeenCalled();
    } else expect(w.svc.realtime.emitToConversation).toHaveBeenCalledWith('c', 'ai:run:end', expect.objectContaining({ status: 'FAILED', finalAction: 'TRANSFERRED_TO_HUMAN' }));
  });
  it('gravação final falha depois da compensação: não repete transferência', async () => {
    const w = world('esp', [batch(reply(TEAM_PROMISE))], [], group);
    w.prisma.aiAgentRun.update.mockRejectedValueOnce(new Error('gravação final'));
    await run(w, 'esp');
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.prisma.aiAgentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', finalAction: 'TRANSFERRED_TO_HUMAN' }) }));
  });
  it('auditoria sem promessa não transfere', async () => {
    const w = world('esp', [batch(reply('Documentos recebidos.'))], [], group);
    w.prisma.aiToolCall.create.mockRejectedValue(new Error('auditoria sintética'));
    await run(w, 'esp');
    expect(w.pending.create).not.toHaveBeenCalled();
    expect(w.complete).toHaveBeenCalledTimes(1);
  });
});

 it.each(['orq', 'esp'])('R7 rechecagem real silenciosa não cria terceira execução: %s', async (agent) => {
  const { GroupNoReplyProcessor, GroupNoReplyService } = await import('./modules/ai-agents/runner/group-no-reply.service');
  const w = world(agent, [batch(reply('')), batch(reply('\u200b\u200c\u200d\ufeff'))]);
  await run(w, agent);
  const guard = new GroupNoReplyService({} as any, w.prisma);
  const router = { shouldHandle: jest.fn().mockResolvedValue({ handle: true }) };
  await new GroupNoReplyProcessor(w.prisma, router as any, w.svc, guard).process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
  expect(w.seen[1]).toContain(NOTE);
  expect(w.runAgents()).toEqual([agent, agent]);
  expect(w.complete).toHaveBeenCalledTimes(2);
  expect(w.sent()).toEqual([]);
  expect(w.runs()).toEqual(['NO_ACTION', 'NO_ACTION']);
});
it.each([true, false])('R7 invisíveis somente em grupo são silêncio: %s', async (group) => {
  const text = '\u200b\u200c\u200d\ufeff';
  const w = world('esp', [batch(reply(text)), stop], [], group);
  await run(w, 'esp');
  expect(w.sent()).toEqual(group ? [] : [text.trim()]);
  expect(w.runs()).toEqual([group ? 'NO_ACTION' : 'REPLIED']);
});

const HANDOFF = { notifyGroupJid: 'synthetic@g.us', assigneeUserId: 'responsavel', notifyLine: 'Dr. Fulano, assuma o chamado.' };
function configured(script: any[], group = true) {
  const w = world('esp', script, [], group);
  w.store.settings = { aiHandoff: { ...HANDOFF } };
  // Use constructor metadata at runtime so pre-change controls exercise the old tool.
  w.tools.transferToHuman = new (TransferToHumanTool as any)(w.svc.realtime, w.pending, w.prisma, w.groupNotify, w.notifications);
  return w;
}
describe('SPEC-022 pelo runner real', () => {
  it.each([null, '', '   '])('R8: nome de grupo %p usa fallback nos dois avisos', async (name) => {
    const w = configured([batch(reply(TEAM_PROMISE))]);
    w.prisma.conversation.findFirst.mockImplementation(async () => ({ ...w.conv(), contact: { name } }));
    await run(w, 'esp');
    expect(w.groupNotify.notifyGroupByJid).toHaveBeenCalledTimes(1);
    expect(w.groupNotify.notifyGroupByJid).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Grupo: Grupo sem nome\n') }));
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    expect(w.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('Grupo: Grupo sem nome. Motivo:') }));
    expect(w.store).toEqual(expect.objectContaining({ aiEnabled: false, assignedToId: 'responsavel', activeAgentId: null }));
    expect(w.pending.create).not.toHaveBeenCalled();
  });

  it.each(['ferramenta', 'promessa'])('critério 1/6: %s pausa, atribui, avisa e mantém dono nulo', async (mode) => {
    const reason = 'Pedido da pessoa';
    const w = configured(mode === 'ferramenta' ? [call('transferToHuman', { reason }), batch(reply('A equipe foi acionada.'))] : [batch(reply(TEAM_PROMISE))]);
    await run(w, 'esp');
    expect(w.pending.create).not.toHaveBeenCalled();
    expect(w.store).toEqual(expect.objectContaining({ aiEnabled: false, assignedToId: 'responsavel', activeAgentId: null }));
    expect(w.prisma.conversation.updateMany).toHaveBeenCalledWith({ where: { id: 'c', organizationId: 'o', OR: [{ aiEnabled: null }, { aiEnabled: true }] }, data: { aiEnabled: false, assignedToId: 'responsavel', activeAgentId: null } });
    const expectedReason = mode === 'ferramenta' ? reason : `A IA disse à pessoa que a equipe seria acionada: "${TEAM_PROMISE}"`;
    expect(w.groupNotify.notifyGroupByJid).toHaveBeenCalledTimes(1);
    expect(w.groupNotify.notifyGroupByJid).toHaveBeenCalledWith({ organizationId: 'o', groupJid: HANDOFF.notifyGroupJid, text: `Chamado da IA\nGrupo: Grupo sintético\nMotivo: ${expectedReason.slice(0, 300)}\n${HANDOFF.notifyLine}`, currentConversationId: 'c', senderName: expect.any(String) });
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    expect(w.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'responsavel', organizationId: 'o' }));
    expect(w.sent()).toEqual([mode === 'ferramenta' ? 'A equipe foi acionada.' : TEAM_PROMISE]);
    expect(w.runs()).toEqual(['TRANSFERRED_TO_HUMAN']);
    expect(w.complete).toHaveBeenCalledTimes(mode === 'ferramenta' ? 2 : 1);
    expect(transferRows(w)[0].output).toEqual(expect.objectContaining({ ok: true, notified: true }));
    expect(transferRows(w)[0].output).not.toHaveProperty('pendingActionId');
  });
  it.each([null, true, 'ausente'])('count zero sem pausa confirmada (%s) cria pendência visível', async (state) => {
    const w = configured([]);
    w.prisma.conversation.updateMany.mockResolvedValue({ count: 0 });
    w.prisma.conversation.findFirst.mockImplementation(async ({ select }: any) =>
      select ? (state === 'ausente' ? null : { aiEnabled: state, assignedToId: null }) : { ...w.conv(), contact: { name: 'Grupo sintético' } });
    const logger = (w.tools.transferToHuman as any).logger;
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const ctx = { organizationId: 'o', conversationId: 'c', runId: 'r', agentId: 'esp' };
    const result = await w.tools.transferToHuman.execute({ reason: 'Motivo' }, ctx);
    expect(w.prisma.conversation.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'c', organizationId: 'o' }, select: { aiEnabled: true, assignedToId: true },
    });
    expect(result.output).toEqual(expect.objectContaining({ pendingActionId: 'pending', status: 'queued_for_processing' }));
    expect(result.output).not.toHaveProperty('alreadyTransferred');
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.svc.realtime.emitToConversation).toHaveBeenCalledWith('c', 'conversation:pending-action', expect.objectContaining({ pendingActionId: 'pending' }));
    const read = state === 'ausente' ? null : { aiEnabled: state, assignedToId: null };
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`Run r: aiHandoff pause not confirmed; state=${JSON.stringify(read)}`));
    expect(w.groupNotify.notifyGroupByJid).not.toHaveBeenCalled();
    expect(w.notifications.notify).not.toHaveBeenCalled();
  });
  it('pausada sem dono atribui por atualização condicional e reutiliza os avisos', async () => {
    const w = configured([]);
    w.store.aiEnabled = false;
    w.prisma.conversation.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const ctx = { organizationId: 'o', conversationId: 'c', runId: 'r', agentId: 'esp' };
    const result = await w.tools.transferToHuman.execute({ reason: 'Motivo' }, ctx);
    expect(w.prisma.conversation.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'c', organizationId: 'o', aiEnabled: false, assignedToId: null },
      data: { assignedToId: HANDOFF.assigneeUserId },
    });
    expect(result.output).toEqual(expect.objectContaining({ ok: true, status: 'transferred', notified: true }));
    expect(result.output).not.toHaveProperty('alreadyTransferred');
    expect(w.groupNotify.notifyGroupByJid).toHaveBeenCalledTimes(1);
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    expect(w.pending.create).not.toHaveBeenCalled();
  });
  it.each(['outro-dono', null])('corrida ao atribuir pausa sem dono: dono final=%s', async (owner) => {
    const w = configured([]);
    w.prisma.conversation.updateMany.mockResolvedValue({ count: 0 });
    let reads = 0;
    w.prisma.conversation.findFirst.mockImplementation(async ({ select }: any) => select
      ? { aiEnabled: false, assignedToId: ++reads === 1 ? null : owner }
      : { ...w.conv(), contact: { name: 'Grupo sintético' } });
    const logger = (w.tools.transferToHuman as any).logger;
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const result = await w.tools.transferToHuman.execute({ reason: 'Motivo' }, { organizationId: 'o', conversationId: 'c', runId: 'r', agentId: 'esp' });
    expect(w.prisma.conversation.updateMany).toHaveBeenCalledTimes(2);
    expect(reads).toBe(2);
    expect(w.prisma.conversation.findFirst).toHaveBeenLastCalledWith({ where: { id: 'c', organizationId: 'o' }, select: { aiEnabled: true, assignedToId: true } });
    if (owner) {
      expect(result.output).toEqual(expect.objectContaining({ alreadyTransferred: true }));
      expect(w.pending.create).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    } else {
      expect(result.output).toEqual(expect.objectContaining({ pendingActionId: 'pending', status: 'queued_for_processing' }));
      expect(result.output).not.toHaveProperty('alreadyTransferred');
      expect(w.pending.create).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Run r: aiHandoff pause not confirmed; state={"aiEnabled":false,"assignedToId":null}'));
    }
    expect(w.groupNotify.notifyGroupByJid).not.toHaveBeenCalled();
    expect(w.notifications.notify).not.toHaveBeenCalled();
  });
  it('critério 2: chamadas concorrentes e repetidas avisam uma vez', async () => {
    const w = configured([]);
    const ctx = { organizationId: 'o', conversationId: 'c', runId: 'r', agentId: 'esp' };
    const results = await Promise.all([w.tools.transferToHuman.execute({ reason: 'Motivo' }, ctx), w.tools.transferToHuman.execute({ reason: 'Motivo' }, ctx)]);
    await w.tools.transferToHuman.execute({ reason: 'Motivo' }, ctx);
    expect(results.every((r: any) => r.output.ok)).toBe(true);
    expect(w.groupNotify.notifyGroupByJid).toHaveBeenCalledTimes(1);
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
  });
  it.each(['individual', 'sem chave'])('critério 3: mantém pendência em %s', async (mode) => {
    const w = configured([batch(tc('transferToHuman')), batch(reply('A equipe foi acionada.'))], mode !== 'individual');
    if (mode === 'sem chave') w.store.settings = {};
    await run(w, 'esp');
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(w.groupNotify.notifyGroupByJid).not.toHaveBeenCalled();
    expect(w.prisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(w.runs()).toEqual(['TRANSFERRED_TO_HUMAN']);
  });
  it.each(['retorno', 'exceção'])('critério 4: falha de aviso por %s mantém pausa e notifica falha', async (mode) => {
    const w = configured([batch(reply(TEAM_PROMISE))]);
    const logger = (w.tools.transferToHuman as any).logger;
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    if (mode === 'retorno') w.groupNotify.notifyGroupByJid.mockResolvedValue({ sent: false, reason: 'Grupo sem conversa registrada' });
    else w.groupNotify.notifyGroupByJid.mockRejectedValue(new Error('fila indisponível'));
    await run(w, 'esp');
    expect(w.store).toEqual(expect.objectContaining({ aiEnabled: false, assignedToId: 'responsavel', activeAgentId: null }));
    expect(transferRows(w)[0].output).toEqual(expect.objectContaining({ ok: true, notified: false }));
    expect(logger.error).toHaveBeenCalled();
    expect(w.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('falhou') }));
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
  });
  it.each(['fora da organização', 'incompleta', 'inválida'])('critério 5 e validação: %s volta à pendência', async (mode) => {
    const w = configured([batch(reply(TEAM_PROMISE))]);
    if (mode === 'fora da organização') w.prisma.userOrganization.findFirst.mockResolvedValue(null);
    if (mode === 'incompleta') w.store.settings.aiHandoff = { assigneeUserId: 'responsavel' };
    if (mode === 'inválida') w.store.settings.aiHandoff.notifyGroupJid = 123;
    const logger = (w.tools.transferToHuman as any).logger;
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    await run(w, 'esp');
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
    expect(w.prisma.conversation.updateMany).not.toHaveBeenCalled();
  });
  it('mesmo grupo não gera erro nem notificação de falha', async () => {
    const w = configured([batch(reply(TEAM_PROMISE))]);
    w.groupNotify.notifyGroupByJid.mockResolvedValue({ sent: false, reason: 'skipped_same_conversation' });
    const logger = (w.tools.transferToHuman as any).logger;
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    await run(w, 'esp');
    expect(logger.error).not.toHaveBeenCalled();
    expect(w.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.not.stringContaining('falhou') }));
    expect(transferRows(w)[0].output.ok).toBe(true);
  });
  it('negativa com configuração não pausa nem avisa', async () => {
    const w = configured([batch(reply('Não vou acionar a equipe agora.'))]);
    await run(w, 'esp');
    expect(w.prisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(w.groupNotify.notifyGroupByJid).not.toHaveBeenCalled();
    expect(w.pending.create).not.toHaveBeenCalled();
  });
  it('critério 7: pausa bloqueia a rechecagem e mensagem nova pelo gate real', async () => {
    const { GroupNoReplyProcessor, GroupNoReplyService } = await import('./modules/ai-agents/runner/group-no-reply.service');
    const { AgentRouterService } = await import('./modules/ai-agents/router/agent-router.service');
    const w = configured([batch(tc('transferToHuman')), batch(reply('A equipe foi acionada.'))]);
    await run(w, 'esp');
    w.prisma.organization.findUnique.mockResolvedValue({ aiPanicMode: false, aiEnabled: true });
    w.prisma.channel.findUnique = jest.fn().mockResolvedValue({ type: 'WHATSAPP', aiEnabled: true });
    const router = new AgentRouterService(w.prisma, {} as any, {} as any);
    const runner = { run: jest.fn() };
    // Incoming replies change the latest message; restore inbound to test the pause itself.
    w.store.messages = [w.store.messages[0]];
    await new GroupNoReplyProcessor(w.prisma, router, runner as any, new GroupNoReplyService({} as any, w.prisma)).process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
    expect(runner.run).not.toHaveBeenCalled();
    expect(await router.shouldHandle(w.conv(), { ...w.store.messages[0], id: 'new' })).toEqual(expect.objectContaining({ handle: false }));
  });
});


describe('R9 checagem pelo runner real', () => {
  const saved = (w: any) => w.prisma.aiAgentRun.update.mock.calls.at(-1)[0].data;
  const checked = (w: any) => w.svc.logger.log.mock.calls.map((c: any[]) => { try { return JSON.parse(c[0]); } catch { return null; } }).filter((v: any) => v?.msg === 'team_promise_checked');
  it('texto sem palavras de equipe também chega à checagem', async () => {
    const text = 'Fulana já ficou sabendo.';
    const w = world('esp', [batch(reply(text))]);
    w.checkComplete.mockResolvedValue(say('SIM'));
    await run(w, 'esp');
    expect(w.checkComplete).toHaveBeenCalledTimes(1);
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(transferRows(w)[0].input.reason).toContain(text);
  });
  it('NAO não repete checagem se a gravação final falhar', async () => {
    const w = world('esp', [batch(reply(TEAM_PROMISE))]);
    w.checkComplete.mockResolvedValue(say('NAO'));
    w.prisma.aiAgentRun.update.mockRejectedValueOnce(new Error('gravação final'));
    await run(w, 'esp');
    expect(w.checkComplete).toHaveBeenCalledTimes(1);
    expect(saved(w)).toEqual(expect.objectContaining({ status: 'FAILED', errorMessage: 'gravação final', inputTokens: 2 }));
    expect(w.pending.create).not.toHaveBeenCalled();
  });
  it.each(['SIM', 'NAO'])('%s usa configuração medida e resultado no banco/evento', async answer => {
    const w = world('esp', [batch(reply(TEAM_PROMISE))]);
    w.checkComplete.mockResolvedValue(say(answer));
    await run(w, 'esp');
    expect(w.checkComplete).toHaveBeenCalledTimes(1);
    expect(w.checkComplete.mock.calls[0][0]).toEqual({ modelId: 'qwen3.7-max', messages: [{ role: 'system', content: TEAM_PROMISE_PROMPT }, { role: 'user', content: `Mensagem enviada:\n"""\n${TEAM_PROMISE}\n"""` }], temperature: 0, maxTokens: 1000, organizationId: 'o' });
    const finalAction = answer === 'SIM' ? 'TRANSFERRED_TO_HUMAN' : 'REPLIED';
    expect(w.pending.create).toHaveBeenCalledTimes(answer === 'SIM' ? 1 : 0);
    expect(saved(w)).toEqual(expect.objectContaining({ status: 'COMPLETED', finalAction, modelId: 'T/t', inputTokens: 2, outputTokens: 2 }));
    expect(w.svc.realtime.emitToConversation).toHaveBeenCalledWith('c', 'ai:run:end', expect.objectContaining({ finalAction, inputTokens: 2 }));
    expect(checked(w)).toEqual([expect.objectContaining({ result: answer.toLowerCase(), attempts: 1, model: 'QWEN/qwen3.7-max', inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: expect.any(Number), runId: 'run1' })]);
    expect(JSON.stringify(checked(w))).not.toContain(TEAM_PROMISE);
  });
  it.each(['exception', 'invalid', 'length'])('duas falhas %s não lançam e avisam sem texto', async mode => {
    const w = world('esp', [batch(reply(TEAM_PROMISE))]);
    w.svc.notifyToolFailure = jest.fn().mockRejectedValue(new Error('aviso falhou'));
    if (mode === 'exception') w.checkComplete.mockRejectedValue(new Error('provedor'));
    else w.checkComplete.mockResolvedValue({ ...say(mode === 'length' ? 'SIM' : 'TALVEZ'), stopReason: mode === 'length' ? 'length' : 'stop' });
    await expect(run(w, 'esp')).resolves.toBeUndefined();
    expect(w.checkComplete).toHaveBeenCalledTimes(2);
    expect(w.pending.create).not.toHaveBeenCalled();
    expect(saved(w)).toEqual(expect.objectContaining({ status: 'COMPLETED', errorMessage: 'team_promise_check_failed', finalAction: 'REPLIED' }));
    expect(w.svc.realtime.emitToConversation).toHaveBeenCalledWith('c', 'ai:run:end', expect.objectContaining({ status: 'COMPLETED', errorMessage: 'team_promise_check_failed' }));
    expect(w.svc.logger.error).toHaveBeenCalledWith(expect.stringMatching(/run1.*team_promise_check_failed/));
    expect(w.svc.notifyToolFailure).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'teamPromiseCheck', input: {}, output: { ok: false, error: 'team_promise_check_failed' } }));
    expect(JSON.stringify(w.svc.notifyToolFailure.mock.calls)).not.toContain(TEAM_PROMISE);
    expect(checked(w)[0]).toEqual(expect.objectContaining({ result: 'failed', attempts: 2 }));
  });
  it.each(['inválida', 'exceção'])('%s seguida de SIM soma todo uso e preserva modelo principal', async mode => {
    const w = world('esp', [batch(reply(TEAM_PROMISE))]);
    const checkUsage = { inputTokens: 7, outputTokens: 1242, cacheReadTokens: 2, cacheWriteTokens: 3, costUsd: 0.2 };
    if (mode === 'exceção') w.checkComplete.mockRejectedValueOnce(new Error('provedor'));
    else w.checkComplete.mockResolvedValueOnce({ ...say('TALVEZ'), usage: checkUsage });
    w.checkComplete.mockResolvedValueOnce({ ...say('SIM'), usage: checkUsage, effectiveProvider: 'CHECK', effectiveModelId: 'other' });
    await run(w, 'esp');
    expect(w.pending.create).toHaveBeenCalledTimes(1);
    expect(saved(w)).toEqual(expect.objectContaining({ modelId: 'T/t', inputTokens: mode === 'exceção' ? 8 : 15, outputTokens: mode === 'exceção' ? 1243 : 2485, cacheReadTokens: mode === 'exceção' ? 2 : 4, cacheWriteTokens: mode === 'exceção' ? 3 : 6, costUsd: mode === 'exceção' ? 0.2 : 0.4 }));
    expect(w.svc.realtime.emitToConversation).toHaveBeenCalledWith('c', 'ai:run:end', expect.objectContaining({ costUsd: mode === 'exceção' ? 0.2 : 0.4, outputTokens: mode === 'exceção' ? 1243 : 2485, modelId: 'T/t' }));
    expect(checked(w)[0]).toEqual(expect.objectContaining({ attempts: 2, costUsd: mode === 'exceção' ? 0.2 : 0.4 }));
  });
  it.each(['SIM', 'NAO', 'FAIL'])('catch preserva erro original, resposta %s', async answer => {
    const w = world('esp', [batch(reply(TEAM_PROMISE))]);
    w.prisma.aiToolCall.create.mockRejectedValue(new Error('auditoria original'));
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    w.checkComplete.mockResolvedValue(say(answer));
    await run(w, 'esp');
    expect(saved(w)).toEqual(expect.objectContaining({ status: 'FAILED', errorMessage: 'auditoria original', inputTokens: answer === 'FAIL' ? 3 : 2 }));
    expect(w.pending.create).toHaveBeenCalledTimes(answer === 'SIM' ? 1 : 0);
    if (answer === 'SIM') expect(saved(w).finalAction).toBe('TRANSFERRED_TO_HUMAN');
    expect(w.checkComplete).toHaveBeenCalledTimes(answer === 'FAIL' ? 2 : 1);
  });
  it.each(['silêncio', 'sem resposta', 'transferiu'])('%s não checa nem gasta a mais', async mode => {
    const w = world('esp', mode === 'silêncio' ? [batch(reply(''))] : mode === 'sem resposta' ? [stop] : [batch(reply(TEAM_PROMISE), tc('transferToHuman'))]);
    await run(w, 'esp');
    expect(w.checkComplete).not.toHaveBeenCalled();
    expect(saved(w).inputTokens).toBe(1);
  });
  it('individual tem próxima vez para transferir sozinho', async () => {
    const w = world('esp', [batch(reply(TEAM_PROMISE)), batch(tc('transferToHuman'))], [], false);
    await run(w, 'esp');
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.checkComplete).not.toHaveBeenCalled();
    expect(w.pending.create).toHaveBeenCalledTimes(1);
  });
  it.each(['SIM', 'NAO', 'já pausada'])('SPEC-022 com resposta %s', async answer => {
    const w = configured([batch(reply(TEAM_PROMISE))]);
    w.checkComplete.mockImplementation(async () => { if (answer === 'já pausada') { w.store.aiEnabled = false; w.store.assignedToId = 'responsavel'; } return say(answer === 'NAO' ? 'NAO' : 'SIM'); });
    await run(w, 'esp');
    expect(w.groupNotify.notifyGroupByJid).toHaveBeenCalledTimes(answer === 'SIM' ? 1 : 0);
    expect(w.notifications.notify).toHaveBeenCalledTimes(answer === 'SIM' ? 1 : 0);
    if (answer === 'SIM') expect(w.store).toEqual(expect.objectContaining({ aiEnabled: false, assignedToId: 'responsavel', activeAgentId: null }));
    if (answer === 'NAO') expect(w.prisma.conversation.updateMany).not.toHaveBeenCalled();
  });
});


describe('R10 checagem fixa com transporte real simulado', () => {
  afterEach(() => jest.restoreAllMocks());
  const saved = (w: any) => w.prisma.aiAgentRun.update.mock.calls.at(-1)[0].data;
  function routed(group: boolean, provider: 'FUGU' | 'QWEN', answer: string, override = false, missing = false) {
    const w = world('esp', [], [], group);
    w.svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    const agent = { ...esp, modelId: 'zai/glm-5.2', modelParams: { max_tokens: 7, top_p: 0.4 } };
    w.prisma.aiAgent.findFirst.mockResolvedValue(agent);
    const resolved = (p: string) => ({ provider: p, apiKey: missing && p === 'QWEN' ? null : 'synthetic-key', source: missing && p === 'QWEN' ? 'NONE' : 'ORG' });
    const resolver = {
      resolveForLlm: jest.fn(async () => ({ ...resolved(provider), modelOverride: override ? 'fugu-ultra-v1.1' : null })),
      resolveProvider: jest.fn(async (_org, p) => resolved(p)),
    };
    const compat = new OpenAiCompatibleAdapter();
    const router = new AiLlmRouterService(resolver as any, {} as any, {} as any, {} as any, {} as any, {} as any, new FuguLlmAdapter(compat), new QwenLlmAdapter(compat));
    w.svc.llmRouter = router;
    const http: any[] = [];
    let mainCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(init!.body as string);
      http.push({ url: String(url), body });
      const check = body.messages[0]?.content === TEAM_PROMISE_PROMPT;
      const message = check ? { role: 'assistant', content: answer } : ++mainCalls === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'reply', type: 'function', function: { name: 'replyToConversation', arguments: JSON.stringify({ text: TEAM_PROMISE }) } }] }
        : { role: 'assistant', content: '' };
      return { ok: true, json: async () => ({ model: body.model, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: check ? 10 : 2, completion_tokens: check ? 4 : 1 } }) } as Response;
    });
    return { w, resolver, router, http };
  }
  describe.each([true, false])('grupo=%s', group => {
    it.each([
      ['FUGU', false, 'SIM'], ['FUGU', false, 'NAO'],
      ['FUGU', true, 'SIM'], ['FUGU', true, 'NAO'],
      ['QWEN', false, 'SIM'], ['QWEN', false, 'NAO'],
    ] as const)('%s override=%s veredito=%s', async (provider, override, answer) => {
      const { w, resolver, http } = routed(group, provider, answer, override);
      await run(w, 'esp');
      const main = http.filter(c => c.body.messages[0]?.content !== TEAM_PROMISE_PROMPT);
      const checks = http.filter(c => c.body.messages[0]?.content === TEAM_PROMISE_PROMPT);
      expect(main).toHaveLength(group ? 1 : 2);
      const mainModel = provider === 'FUGU' ? override ? 'fugu-ultra-v1.1' : 'fugu-ultra' : 'qwen3.7-max';
      expect(main[0].body.model).toBe(mainModel);
      expect(main[0].url).toBe(provider === 'FUGU' ? 'https://api.sakana.ai/v1/chat/completions' : 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
      if (provider === 'FUGU') expect(main[0].body).not.toHaveProperty('temperature');
      expect(checks).toEqual([{ url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', body: {
        model: 'qwen3.7-max', messages: [{ role: 'system', content: TEAM_PROMISE_PROMPT }, { role: 'user', content: `Mensagem enviada:\n"""\n${TEAM_PROMISE}\n"""` }], temperature: 0, max_tokens: 1000,
      } }]);
      expect(resolver.resolveProvider).toHaveBeenCalledTimes(1);
      expect(resolver.resolveProvider).toHaveBeenCalledWith('o', AiProvider.QWEN);
      expect(w.pending.create).toHaveBeenCalledTimes(answer === 'SIM' ? 1 : 0);
      const mainCount = group ? 1 : 2;
      const mainCost = provider === 'FUGU' ? 2 * 5 / 1e6 + 30 / 1e6 : 2 * 2.5 / 1e6 + 7.5 / 1e6;
      expect(saved(w)).toEqual(expect.objectContaining({ status: 'COMPLETED', finalAction: answer === 'SIM' ? 'TRANSFERRED_TO_HUMAN' : 'REPLIED', modelId: `${provider}/${mainModel}`, inputTokens: mainCount * 2 + 10, outputTokens: mainCount + 4 }));
      expect(saved(w).costUsd).toBeCloseTo(mainCount * mainCost + 10 * 2.5 / 1e6 + 4 * 7.5 / 1e6, 12);
      const log = w.svc.logger.log.mock.calls.map((c: any[]) => { try { return JSON.parse(c[0]); } catch { return null; } }).find((v: any) => v?.msg === 'team_promise_checked');
      expect(log).toEqual(expect.objectContaining({ model: 'QWEN/qwen3.7-max', result: answer.toLowerCase() }));
    });
    it('sem credencial Qwen mantém principal e avisa após duas tentativas sem HTTP de checagem', async () => {
      const { w, resolver, http } = routed(group, 'FUGU', 'SIM', false, true);
      await run(w, 'esp');
      expect(resolver.resolveProvider).toHaveBeenCalledTimes(2);
      expect(http).toHaveLength(group ? 1 : 2);
      expect(http.every(c => c.url === 'https://api.sakana.ai/v1/chat/completions' && c.body.messages[0]?.content !== TEAM_PROMISE_PROMPT)).toBe(true);
      expect(w.sent()).toEqual([TEAM_PROMISE]);
      expect(saved(w)).toEqual(expect.objectContaining({ status: 'COMPLETED', finalAction: 'REPLIED', errorMessage: 'team_promise_check_failed', modelId: 'FUGU/fugu-ultra', inputTokens: group ? 2 : 4, outputTokens: group ? 1 : 2 }));
      expect(w.pending.create).not.toHaveBeenCalled();
      expect(w.svc.notifyToolFailure).toHaveBeenCalledTimes(1);
      expect(w.svc.notifyToolFailure).toHaveBeenCalledWith(expect.objectContaining({ input: {}, output: { ok: false, error: 'team_promise_check_failed' } }));
      expect(JSON.stringify(w.svc.notifyToolFailure.mock.calls)).not.toContain(TEAM_PROMISE);
      expect(JSON.stringify(w.svc.logger.log.mock.calls)).not.toContain(TEAM_PROMISE);
      expect(w.svc.logger.log).toHaveBeenCalledWith(expect.stringContaining('"model":"QWEN/qwen3.7-max"'));
      expect(w.svc.logger.log).toHaveBeenCalledWith(expect.stringContaining('"attempts":2'));
    });
  });
  it('método direto exige organização, sem resolver credenciais ou chamar HTTP', async () => {
    const { router, resolver, http } = routed(true, 'FUGU', 'NAO');
    await expect((router as any).completeWithProvider(AiProvider.QWEN, { modelId: 'qwen3.7-max', messages: [] })).rejects.toThrow('requires organizationId');
    expect(resolver.resolveProvider).not.toHaveBeenCalled();
    expect(http).toEqual([]);
  });
});
