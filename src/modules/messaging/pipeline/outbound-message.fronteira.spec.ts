import { OutboundMessageProcessor } from './outbound-message.processor';

describe('fronteira da conciliação de eco de saída', () => {
  it('reconcilia apenas com eco da mesma conversa', async () => {
    const placeholder = { id: 'local', conversationId: 'conv-A', senderId: 'sender', content: {} };
    const echo = { id: 'echo-A', conversationId: 'conv-A', senderId: null };
    const findFirst = jest.fn(async ({ where }: any) => where.conversationId === 'conv-A' ? echo : { id: 'echo-B', conversationId: 'conv-B' });
    const update = jest.fn().mockRejectedValueOnce({ code: 'P2002' }).mockResolvedValue(echo);
    const prisma = { channel: { findUniqueOrThrow: jest.fn(async () => ({ id: 'channel-A', type: 'TEST', organizationId: 'org-A' })) }, message: { update, findUnique: jest.fn(async () => placeholder), findFirst, delete: jest.fn(async () => undefined), findUniqueOrThrow: jest.fn().mockResolvedValueOnce({ conversation: { id: 'conv-A', organizationId: 'org-A' } }).mockResolvedValue(echo) } };
    const adapter = { sendMessage: jest.fn(async () => ({ externalId: 'external' })) };
    const gateway = { emitToConversation: jest.fn(), emitToChannel: jest.fn() };
    const processor = new OutboundMessageProcessor(prisma as any, { getOutbound: () => adapter } as any, gateway as any, { markProcessed: jest.fn() } as any);
    await processor.process({ data: { messageId: 'local', channelId: 'channel-A', contactExternalId: 'contact', message: {} } } as any);
    expect(findFirst).toHaveBeenCalledWith({ where: { externalId: 'external', id: { not: 'local' }, conversationId: 'conv-A' } });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'echo-A' } }));
  });
});
