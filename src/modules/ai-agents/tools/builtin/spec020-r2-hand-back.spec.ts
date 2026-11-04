import { HandBackToOrchestratorTool } from './hand-back-to-orchestrator.tool';

it('não troca o dono durante a checagem de grupo', async () => {
  const prisma = { $transaction: jest.fn().mockResolvedValue([]), conversation: { update: jest.fn() }, aiAgentHandoff: { create: jest.fn() }, conversationAuditLog: { create: jest.fn() } };
  const result = await new HandBackToOrchestratorTool(prisma as any, { emitToConversation: jest.fn() } as any).execute({ reason: 'Outro assunto' }, { organizationId: 'o', conversationId: 'c', channelId: 'ch', contactId: 'ct', agentId: 'a', runId: 'r', expectedLatestMessageId: 'm' });
  expect(result.output).toEqual(expect.objectContaining({ ok: false }));
  expect(prisma.conversation.update).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
