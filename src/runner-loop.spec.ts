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
  const conv = () => ({ id: 'c', organizationId: 'o', channelId: 'ch', contactId: 'ct', isGroup: group, aiEnabled: store.aiEnabled, activeAgentId: store.activeAgentId });
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
      updateMany: jest.fn(async ({ where, data }: any) => { if (where.aiEnabled && store.aiEnabled === false) return { count: 0 }; Object.assign(store, data); return { count: 1 }; }),
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
  it.each(['solto', 'ferramenta'])('%s cria uma pendência auditada, sem nova consulta', async (mode) => {
    const w = world('esp', [mode === 'solto' ? say(TEAM_PROMISE) : batch(reply(TEAM_PROMISE))], [], group);
    await run(w, 'esp');
    expect(w.sent()).toEqual([TEAM_PROMISE]);
    expect(w.complete).toHaveBeenCalledTimes(1);
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
  it.each(['ferramenta', 'promessa'])('critério 1/6: %s pausa, atribui, avisa e mantém dono nulo', async (mode) => {
    const reason = 'Pedido da pessoa';
    const w = configured(mode === 'ferramenta' ? [call('transferToHuman', { reason }), batch(reply('A equipe foi acionada.'))] : [batch(reply(TEAM_PROMISE))]);
    await run(w, 'esp');
    expect(w.pending.create).not.toHaveBeenCalled();
    expect(w.store).toEqual(expect.objectContaining({ aiEnabled: false, assignedToId: 'responsavel', activeAgentId: null }));
    expect(w.prisma.conversation.updateMany).toHaveBeenCalledWith({ where: { id: 'c', organizationId: 'o', aiEnabled: { not: false } }, data: { aiEnabled: false, assignedToId: 'responsavel', activeAgentId: null } });
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
