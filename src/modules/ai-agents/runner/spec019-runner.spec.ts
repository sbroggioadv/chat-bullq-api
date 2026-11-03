import { AiAgentRunnerService } from './agent-runner.service';

async function execute(stopReason: string, content: string, fail = false) {
  const agent = { id: 'a', name: 'Agente', kind: 'ORCHESTRATOR', modelId: 'old', maxTokens: 2048 };
  const svc = Object.create(AiAgentRunnerService.prototype) as any;
  const update = jest.fn().mockResolvedValue({});
  svc.prisma = { aiAgent: { findFirst: jest.fn().mockResolvedValue(agent) }, organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, contact: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) }, message: { findMany: jest.fn().mockResolvedValue([]) }, aiAgentMemory: { findUnique: jest.fn().mockResolvedValue(null) }, aiAgentRun: { create: jest.fn().mockResolvedValue({ id: 'run-1' }), update }, aiResponseLog: { create: jest.fn().mockResolvedValue({}) }, conversation: { update: jest.fn().mockResolvedValue({}) } };
  svc.agentRouter = { selectAgent: jest.fn().mockResolvedValue({ agentId: 'a' }) };
  svc.cadence = { evaluate: jest.fn().mockResolvedValue({ shouldSend: true, delayMs: 0 }) };
  svc.catalogSync = { getCompactCatalog: jest.fn().mockResolvedValue([]) };
  svc.mediaUrlResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
  svc.promptBuilder = { buildMessages: jest.fn().mockReturnValue([]) };
  svc.resolveToolsAndSkills = jest.fn().mockResolvedValue({ llmTools: [], customSkillsByName: new Map(), skillInstructions: [] });
  svc.augmentSystemPromptWithLayers = jest.fn();
  svc.scheduleAfterRunJobs = jest.fn().mockResolvedValue(undefined);
  svc.realtime = { emitToConversation: jest.fn() };
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  svc.llmRouter = { prepare: jest.fn().mockResolvedValue({ provider: 'FUGU', modelId: 'fugu-ultra', complete: fail ? jest.fn().mockRejectedValue(new Error('falha')) : jest.fn().mockResolvedValue({ message: { content }, stopReason, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, effectiveProvider: 'FUGU', effectiveModelId: 'fugu-ultra-20260615' }) }), complete: jest.fn().mockResolvedValue({ message: { content }, stopReason, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, effectiveProvider: 'FUGU', effectiveModelId: 'fugu-ultra' }) };
  await svc.run({ conversation: { id: 'c', organizationId: 'org', channelId: 'ch', contactId: 'ct' }, triggerMessage: { id: 'm', content: '' } });
  return { update, create: svc.prisma.aiAgentRun.create, realtime: svc.realtime, logger: svc.logger };
}

it('registra modelo efetivo e esgotamento sem resposta', async () => {
  const { update, logger } = await execute('length', '');
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ modelId: 'FUGU/fugu-ultra-20260615', finalAction: 'NO_ACTION', errorMessage: expect.stringMatching(/teto de 2048/) }) }));
  expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/run-1.*FUGU.*fugu-ultra.*2048/));
});
it('conclusão normal não registra esgotamento', async () => {
  const { update, logger } = await execute('stop', '');
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ errorMessage: expect.any(String) }) }));
  expect(logger.warn).not.toHaveBeenCalled();
});


it.each([false, true])('registra e anuncia modelo antes e depois, falha=%s', async (fail) => {
  const { create, update, realtime } = await execute('stop', '', fail);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ modelId: 'FUGU/fugu-ultra' }) }));
  expect(realtime.emitToConversation).toHaveBeenCalledWith('c', 'ai:run:start', expect.objectContaining({ modelId: 'FUGU/fugu-ultra' }));
  expect(realtime.emitToConversation).toHaveBeenCalledWith('c', 'ai:run:end', expect.objectContaining({ modelId: fail ? 'FUGU/fugu-ultra' : 'FUGU/fugu-ultra-20260615' }));
  if (fail) expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', modelId: 'FUGU/fugu-ultra' }) }));
});
