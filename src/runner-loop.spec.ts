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
  const pending = { create: jest.fn().mockResolvedValue({ id: 'pending' }) };
  const action = { execute: jest.fn().mockResolvedValue({ output: { ok: true } }) };
  const tools: any = {
    transferToHuman: new TransferToHumanTool(realtime as any, pending as any),
    tagConversation: action, grantAccess: action, listAvailableAgents: action,
    replyToConversation: replyTool,
    delegateToAgent: new DelegateToAgentTool(prisma, realtime as any, outbound as any),
    handBackToOrchestrator: new HandBackToOrchestratorTool(prisma, realtime as any),
  };
  svc.registry = { has: (n: string) => n in tools, isAllowedForAgent: () => true, get: (n: string) => tools[n] };
  const seen: string[] = [];
  const w: any = { svc, store, conv, prisma, outbound, seen, replyCtx, replyOut, pending, action, tools };
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
