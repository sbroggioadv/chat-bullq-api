import { ReplyToConversationTool } from './reply-to-conversation.tool';

it('não envia se outra mensagem chegou durante a checagem', async () => {
  const prisma = {
    aiAgent: { findUnique: jest.fn().mockResolvedValue({ name: 'Agente' }) },
    contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'x' }) },
    conversation: { findUnique: jest.fn().mockResolvedValue({ organization: {} }), update: jest.fn() },
    message: { findFirst: jest.fn().mockResolvedValue({ id: 'new' }), create: jest.fn() },
  };
  const queue = { add: jest.fn() };
  const tool = new ReplyToConversationTool(prisma as any, {} as any, queue as any);
  const result = await tool.execute({ text: 'Olá pessoal' }, { organizationId: 'o', conversationId: 'c', channelId: 'ch', contactId: 'ct', agentId: 'a', runId: 'r', expectedLatestMessageId: 'old' });
  expect(result.output).toEqual(expect.objectContaining({ ok: false, error: 'stale_group_check' }));
  expect(prisma.message.create).not.toHaveBeenCalled();
  expect(queue.add).not.toHaveBeenCalled();
});
