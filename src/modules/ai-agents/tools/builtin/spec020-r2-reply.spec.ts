import { ReplyToConversationTool } from './reply-to-conversation.tool';

it('não envia se outra mensagem chegou durante a checagem', async () => {
  const prisma = {
    aiAgent: { findUnique: jest.fn().mockResolvedValue({ name: 'Agente' }) },
    contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'x' }) },
    conversation: { findUnique: jest.fn().mockResolvedValue({ organization: {} }), update: jest.fn() },
    message: { findMany: jest.fn().mockResolvedValue([{ id: 'new', direction: 'INBOUND' }, { id: 'old' }]), create: jest.fn() },
  };
  const queue = { add: jest.fn() };
  const tool = new ReplyToConversationTool(prisma as any, {} as any, queue as any);
  const result = await tool.execute({ text: 'Olá pessoal' }, { organizationId: 'o', conversationId: 'c', channelId: 'ch', contactId: 'ct', agentId: 'a', runId: 'r', expectedLatestMessageId: 'old' });
  expect(result.output).toEqual(expect.objectContaining({ ok: false, error: 'stale_group_check' }));
  expect(prisma.message.create).not.toHaveBeenCalled();
  expect(queue.add).not.toHaveBeenCalled();
});


it('rejeita mensagem externa mesmo que a transição da cadeia seja mais recente', async () => {
  const prisma = {
    aiAgent: { findUnique: jest.fn().mockResolvedValue({ name: 'Agente' }) },
    contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'x' }) },
    conversation: { findUnique: jest.fn().mockResolvedValue({ organization: {} }), update: jest.fn() },
    message: { findMany: jest.fn().mockResolvedValue([
      { id: 'transition', direction: 'OUTBOUND', metadata: { runId: 'r1' } },
      { id: 'new', direction: 'INBOUND' },
      { id: 'old', revokedAt: null },
    ]), create: jest.fn() },
  };
  const queue = { add: jest.fn() };
  const result = await new ReplyToConversationTool(prisma as any, {} as any, queue as any).execute(
    { text: 'Olá pessoal' },
    { organizationId: 'o', conversationId: 'c', channelId: 'ch', contactId: 'ct', agentId: 'a', runId: 'r2', expectedLatestMessageId: 'old', checkRunIds: ['r1', 'r2'] },
  );
  expect(result.output).toEqual(expect.objectContaining({ ok: false, error: 'stale_group_check' }));
  expect(prisma.message.create).not.toHaveBeenCalled();
  expect(queue.add).not.toHaveBeenCalled();
});
