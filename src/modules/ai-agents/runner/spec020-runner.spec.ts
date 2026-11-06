import { AiAgentRunnerService } from './agent-runner.service';

async function execute(group: boolean, direct: boolean, content: string, action?: string, depth = 0, exhaustion = false, kind?: string, intent?: string, noAction = false, stale = false, prepTurns = 0) {
  const agent = { id: 'a', name: 'Agente', kind: kind ?? (action ? 'WORKER' : 'ORCHESTRATOR'), canRespondDirectly: direct, modelId: 'old', maxTokens: 2048 };
  const svc = Object.create(AiAgentRunnerService.prototype) as any;
  const update = jest.fn().mockResolvedValue({});
  svc.prisma = { aiAgent: { findFirst: jest.fn().mockResolvedValue(agent) }, organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, contact: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, message: { findMany: jest.fn().mockResolvedValue([]) }, aiAgentMemory: { findUnique: jest.fn().mockResolvedValue(null) }, aiAgentRun: { create: jest.fn().mockResolvedValue({ id: 'run-1' }), update }, aiResponseLog: { create: jest.fn().mockResolvedValue({}) }, conversation: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ id: 'c', organizationId: 'org', channelId: 'ch', contactId: 'ct', activeAgentId: null, isGroup: group }) } };
  svc.prisma.aiAgentChannel = { findFirst: jest.fn().mockResolvedValue({ agent: { id: 'o', kind: 'ORCHESTRATOR', canRespondDirectly: direct } }) };
  svc.agentRouter = { selectAgent: jest.fn().mockResolvedValue({ agentId: 'a', classifiedIntent: intent, noAction }) };
  svc.cadence = { evaluate: jest.fn().mockResolvedValue({ shouldSend: true, delayMs: 0 }) };
  svc.catalogSync = { getCompactCatalog: jest.fn().mockResolvedValue([]) };
  svc.mediaUrlResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
  svc.promptBuilder = { buildMessages: jest.fn().mockReturnValue([]) };
  svc.resolveToolsAndSkills = jest.fn().mockResolvedValue({ llmTools: [], customSkillsByName: new Map(), skillInstructions: [] });
  svc.augmentSystemPromptWithLayers = jest.fn();
  svc.scheduleAfterRunJobs = jest.fn().mockResolvedValue(undefined);
  svc.realtime = { emitToConversation: jest.fn() };
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const complete = jest.fn().mockResolvedValue({ message: action ? { content: '', toolCalls: [{ id: 't', name: 'handBackToOrchestrator', arguments: {} }] } : { content }, stopReason: action ? 'tool_calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
  svc.llmRouter = { prepare: jest.fn().mockResolvedValue({ provider: 'TEST', modelId: 'test', complete }) };
  const toolExecute = jest.fn(async (_input: any, _ctx: any) => ({ output: stale ? { error: 'stale_group_check' } : { ok: true } }));
  svc.registry = { get: jest.fn((name: string) => ({ execute: jest.fn(async (input: any, ctx: any) => ({ ...await toolExecute(input, ctx), finalAction: stale ? undefined : name === 'transferToHuman' ? 'TRANSFERRED_TO_HUMAN' : 'REPLIED' })) })) };
  svc.toolExecute = toolExecute;
  svc.executeToolCalls = jest.fn().mockResolvedValue([{ toolName: 'handBackToOrchestrator', toolCallId: 't', output: { ok: true }, finalAction: action }]);
  if (intent === 'ESCALATE_HUMAN') {
    svc.registry.has = () => true;
    svc.registry.isAllowedForAgent = () => true;
    svc.prisma.aiToolCall = { create: jest.fn().mockResolvedValue({ id: 'tool-row' }) };
    svc.notifyToolFailure = jest.fn().mockResolvedValue(undefined);
    svc.executeToolCalls = AiAgentRunnerService.prototype['executeToolCalls'];
  }
  if (action) complete.mockResolvedValueOnce({ message: { content: '', toolCalls: [{ id: 't', name: 'handBackToOrchestrator', arguments: {} }] }, stopReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } }).mockResolvedValue({ message: { content: '' }, stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
  if (exhaustion) complete.mockResolvedValueOnce({ message: { content: '' }, stopReason: 'length', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
  if (prepTurns) {
    for (let i = 0; i < prepTurns; i++) complete.mockResolvedValueOnce({ message: { content: '', toolCalls: [{ id: `prep-${i}`, name: 'lookupOffering', arguments: {} }] }, stopReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
    const actual = svc.executeToolCalls.bind(svc);
    svc.executeToolCalls = jest.fn((calls: any[], ...args: any[]) => calls[0].name === 'lookupOffering' ? Promise.resolve([{ toolName: 'lookupOffering', toolCallId: 'prep', output: { ok: true } }]) : actual(calls, ...args));
  }
  const originalRun = svc.run.bind(svc);
  svc.run = jest.fn().mockImplementationOnce(originalRun).mockResolvedValue(undefined);
  await svc.run({ conversation: { id: 'c', organizationId: 'org', channelId: 'ch', contactId: 'ct', isGroup: group }, triggerMessage: { id: 'm', content: '' }, chainDepth: depth, ...(stale ? { expectedLatestMessageId: 'm' } : {}) });
  return { svc, update, complete };
}

it('empurra uma vez só em conversa individual', async () => {
  expect((await execute(false, true, '')).complete).toHaveBeenCalledTimes(2);
  expect((await execute(true, true, '')).complete).toHaveBeenCalledTimes(1);
  expect((await execute(false, false, '')).complete).toHaveBeenCalledTimes(1);
});
it('grupo não envia texto solto e registra NO_ACTION', async () => {
  const { svc, update } = await execute(true, true, 'Uma resposta solta');
  expect(svc.registry.get).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ finalAction: 'NO_ACTION' }) }));
});
it('encadeia devolução apenas para conversacional e respeita profundidade', async () => {
  expect((await execute(false, true, '', 'HANDED_BACK')).svc.run).toHaveBeenCalledTimes(2);
  expect((await execute(false, false, '', 'HANDED_BACK')).svc.run).toHaveBeenCalledTimes(1);
  expect((await execute(false, true, '', 'HANDED_BACK', 3)).svc.run).toHaveBeenCalledTimes(1);
});

it('preserva o registro de esgotamento após o empurrão sem resposta', async () => {
  const { update, complete } = await execute(false, true, '', undefined, 0, true);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ finalAction: 'NO_ACTION', errorMessage: expect.stringContaining('teto de 2048') }) }));
});

 it('descarta texto solto só do orquestrador conversacional em grupo e registra aviso', async () => {
  const { svc } = await execute(true, true, 'Resposta solta');
  expect(svc.registry.get).not.toHaveBeenCalled();
  expect(svc.logger.warn).toHaveBeenCalledWith(expect.stringContaining('discarded group text'));
});

it.each([['WORKER', true], ['ORCHESTRATOR', false]])('envia fallback de %s em grupo', async (kind, direct) => {
  const { svc } = await execute(true, direct, 'Resposta solta', undefined, 0, false, kind);
  expect(svc.registry.get).toHaveBeenCalledWith('replyToConversation');
});

it('SMALL_TALK silencioso registra run concluído sem preparar ou chamar modelo', async () => {
  const { svc, complete } = await execute(true, true, '', undefined, 0, false, undefined, 'SMALL_TALK', true);
  expect(complete).not.toHaveBeenCalled();
  expect(svc.llmRouter.prepare).not.toHaveBeenCalled();
  expect(svc.prisma.aiAgentRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', finalAction: 'NO_ACTION', classifiedIntent: 'SMALL_TALK' }) }));
});
it.each(['ESCALATE_HUMAN', 'AMBIGUOUS'])('texto solto %s recebe um único nudge', async (intent) => {
  const { svc, complete, update } = await execute(true, true, 'Vou chamar a equipe para ajudar.', undefined, 0, false, undefined, intent);
  expect(complete).toHaveBeenCalledTimes(2);
  const nudges = complete.mock.calls[1][0].messages.filter((m: any) => typeof m.content === 'string' && m.content.startsWith('Em grupo,'));
  expect(nudges).toHaveLength(1);
  if (intent === 'ESCALATE_HUMAN') {
    expect(svc.registry.get.mock.calls.filter(([name]: string[]) => name === 'transferToHuman')).toHaveLength(1);
    expect(svc.toolExecute).toHaveBeenCalledWith({ reason: 'Vou chamar a equipe para ajudar.' }, expect.objectContaining({ runId: 'run-1' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ finalAction: 'TRANSFERRED_TO_HUMAN' }) }));
  } else {
    expect(svc.registry.get).not.toHaveBeenCalled();
    expect(svc.logger.warn).toHaveBeenCalledWith(expect.stringContaining('discarded group text'));
  }
});
it('fallback de escalonamento interrompe ao receber stale_group_check antes de transferir', async () => {
  const { svc, update } = await execute(true, true, 'Vou chamar a equipe.', undefined, 0, false, undefined, 'ESCALATE_HUMAN', false, true);
  expect(svc.registry.get).toHaveBeenCalledWith('replyToConversation');
  expect(svc.registry.get).not.toHaveBeenCalledWith('transferToHuman');
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorMessage: 'stale_group_check' }) }));
});

it('permite exatamente um nudge mesmo quando texto chega na oitava iteração', async () => {
  const { svc, complete } = await execute(true, true, 'Vou chamar a equipe.', undefined, 0, false, undefined, 'ESCALATE_HUMAN', false, false, 7);
  expect(complete).toHaveBeenCalledTimes(9);
  expect(svc.registry.get.mock.calls.filter(([name]: string[]) => name === 'transferToHuman')).toHaveLength(1);
});


it.each([
  'Não devo responder no grupo. O cliente precisa mandar documentos com prazo amanhã.',
  '[O cliente precisa mandar documentos com prazo amanhã.]',
  'Como assistente, preciso chamar a equipe.',
  'Human: oi',
  'x',
  'Não devo responder ' + 'documentos urgentes '.repeat(40),
])('escalona texto bruto mesmo sanitizado vazio ou curto: %s', async (rawText) => {
  const { svc, complete, update } = await execute(true, true, rawText, undefined, 0, false, undefined, 'ESCALATE_HUMAN');
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1][0].messages.filter((m: any) => typeof m.content === 'string' && m.content.startsWith('Em grupo,'))).toHaveLength(1);
  expect(svc.registry.get.mock.calls.map(([name]: string[]) => name)).toEqual(['replyToConversation', 'transferToHuman']);
  expect(svc.toolExecute.mock.calls.map(([input]: any[]) => input)).toEqual([
    { text: 'Vou acionar a equipe para ajudar com seu pedido.' },
    { reason: rawText.slice(0, 500) },
  ]);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ finalAction: 'TRANSFERRED_TO_HUMAN' }) }));
});

it.each(['', '   '])('escalonamento sem texto bruto não gera nudge nem transferência: %s', async (rawText) => {
  const { svc, complete } = await execute(true, true, rawText, undefined, 0, false, undefined, 'ESCALATE_HUMAN');
  expect(complete).toHaveBeenCalledTimes(1);
  expect(svc.registry.get).not.toHaveBeenCalled();
});
