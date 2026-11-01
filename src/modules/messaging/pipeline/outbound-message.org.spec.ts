import { OutboundMessageProcessor } from './outbound-message.processor';

describe('fronteira de envio', () => {
  function setup(channelOrg: string) {
    const update = jest.fn(async ({ data }: any) => ({ id: 'msg', conversationId: 'conv', ...data }));
    const prisma: any = { channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'channel', organizationId: channelOrg, type: 'TEST' }) }, message: { findUniqueOrThrow: jest.fn().mockResolvedValue({ conversation: { id: 'conv', organizationId: 'org-b' } }), findUnique: jest.fn().mockResolvedValue({ metadata: {}, conversationId: 'conv' }), update } };
    const adapter = { sendMessage: jest.fn().mockResolvedValue({ externalId: 'external' }) };
    const gateway = { emitToConversation: jest.fn(), emitToChannel: jest.fn() };
    const processor = new OutboundMessageProcessor(prisma, { getOutbound: () => adapter } as any, gateway as any, { markProcessed: jest.fn() } as any);
    return { processor, adapter, update, gateway };
  }
  const job: any = { data: { messageId: 'msg', channelId: 'channel', contactExternalId: 'synthetic', message: {} } };
  it('marca falha permanente e não chama provedor para canal de outro espaço', async () => {
    const { processor, adapter, update, gateway } = setup('org-a');
    await expect(processor.process(job)).resolves.toEqual(expect.objectContaining({ success: false }));
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', failedReason: 'cross_org_channel' }) }));
    expect(gateway.emitToConversation).toHaveBeenCalledWith('conv', 'message:status', expect.objectContaining({ status: 'FAILED' }));
  });
  it('mantém envio pelo canal da própria organização', async () => {
    const { processor, adapter } = setup('org-b');
    await expect(processor.process(job)).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
  });
});
