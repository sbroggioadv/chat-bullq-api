import { NotificationProcessor } from './notification.processor';

describe('fronteira da notificação em tempo real', () => {
  it('entrega para a organização da notificação', async () => {
    const gateway = { emitToUserInOrg: jest.fn(), emitToUser: jest.fn() };
    const processor = new NotificationProcessor(gateway as any);
    await processor.process({ data: { notificationId: 'n-A', recipientId: 'user', organizationId: 'A', title: 'teste' } } as any);
    expect(gateway.emitToUserInOrg).toHaveBeenCalledWith('user', 'A', 'notification:new', expect.objectContaining({ id: 'n-A' }));
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });
});
