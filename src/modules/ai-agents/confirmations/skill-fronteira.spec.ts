import { PendingActionExecutorProcessor } from './pending-action-executor.processor';

describe('skill da ação aprovada', () => {
  const action = { agentRunId: 'run-a', conversationId: 'conv-a', agentId: 'agent-a', toolName: 'igual', args: {} };
  function setup() {
    const findFirst = jest.fn(async ({ where }: any) => where.organizationId === 'org-a' ? { name: 'igual', toolId: 'tool-a' } : { name: 'igual', toolId: 'tool-b' });
    const prisma = { aiSkill: { findFirst }, aiTool: { findUnique: jest.fn().mockResolvedValue({ id: 'tool-a' }) }, aiAgentRun: { findFirst: jest.fn().mockResolvedValue({ organizationId: 'org-a', triggerMessageId: null }), findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-a', triggerMessageId: null }) }, conversation: { findUnique: jest.fn().mockResolvedValue({ contactId: 'contato-a', channelId: 'canal-a' }) } };
    const execute = jest.fn().mockResolvedValue({ output: 'ok' });
    return { prisma, execute, processor: new PendingActionExecutorProcessor(prisma as any, { execute } as any, {} as any) };
  }
  it('seleciona a skill da organização validada, não homônima de outra', async () => {
    const { prisma, execute, processor } = setup();
    await (processor as any).executeHttpSkill(action, 'org-a');
    expect(prisma.aiSkill.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ name: 'igual', organizationId: 'org-a' }) }));
    expect(execute.mock.calls[0][0].toolId).toBe('tool-a');
  });
  it('permite execução legítima com a organização correta', async () => {
    const { execute, processor } = setup();
    await expect((processor as any).executeHttpSkill(action, 'org-a')).resolves.toBe('ok');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
