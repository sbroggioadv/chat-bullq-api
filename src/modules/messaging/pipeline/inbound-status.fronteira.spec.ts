import { InboundMessageProcessor } from './inbound-message.processor';

describe('fronteira do status recebido', () => {
  it('não atualiza mensagem de outro canal com o mesmo id externo e atualiza a do canal legítimo', async () => {
    const a = { id: 'message-A', conversationId: 'conv-A', status: 'SENT', sentAt: new Date(0) };
    const b = { id: 'message-B', conversationId: 'conv-B', status: 'SENT', sentAt: new Date(0) };
    const findFirst = jest.fn(async ({ where }: any) => where.conversation?.channelId === 'channel-B' ? b : a);
    const update = jest.fn(async ({ where }: any) => ({ ...(where.id === a.id ? a : b), status: 'DELIVERED' }));
    const prisma = { message: { findFirst, update } };
    const gateway = { emitToConversation: jest.fn() };
    const processor = new InboundMessageProcessor(prisma as any, {} as any, {} as any, {} as any, gateway as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await processor.process({ name: 'process-status', data: { channelId: 'channel-B', status: { externalMessageId: 'same-id', status: 'delivered', timestamp: new Date(1) } } } as any);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ conversation: { channelId: 'channel-B' } }) }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'message-B' } }));
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'message-A' } }));
  });
});
