import { NotificationsService } from './notifications.service';
import { NotificationProcessor } from './notification.processor';
import { RealtimeGateway } from '../realtime/realtime.gateway';

describe('SPEC-023 silêncio nos alertas', () => {
  const params = { recipientId: 'user', organizationId: 'org', type: 'NEW_MESSAGE' as any, title: 'título', body: 'texto', data: { conversationId: 'conv' } };
  it.each([null, new Date(0), new Date(Date.now() + 3600000)])('suprime só enquanto mutedUntil=%s', async mutedUntil => {
    const prisma: any = { conversation: { findFirst: jest.fn().mockResolvedValue({ mutedUntil }) } };
    const repo: any = { create: jest.fn().mockResolvedValue({ id: 'notification' }) };
    const queue: any = { add: jest.fn() };
    await new NotificationsService(repo, prisma, queue).notify(params);
    const muted = !!mutedUntil && mutedUntil.getTime() > Date.now();
    expect(repo.create).toHaveBeenCalledTimes(muted ? 0 : 1);
    expect(queue.add).toHaveBeenCalledTimes(muted ? 0 : 1);
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({ where: { id: 'conv', organizationId: 'org' }, select: { mutedUntil: true } });
  });
  it('reavalia o silêncio na entrega de job já enfileirado', async () => {
    const prisma: any = { conversation: { findFirst: jest.fn().mockResolvedValue({ mutedUntil: new Date('9999-12-31') }) } };
    const gateway: any = { emitToUserInOrg: jest.fn() };
    expect(await new NotificationProcessor(gateway, prisma).process({ data: params } as any)).toMatchObject({ delivered: false });
    expect(gateway.emitToUserInOrg).not.toHaveBeenCalled();
  });
  it('realtime informa silêncio sem impedir emissão ou alterar a mensagem', async () => {
    const prisma: any = { conversation: { findFirst: jest.fn().mockResolvedValue({ mutedUntil: new Date('9999-12-31T23:59:59Z') }) } };
    const gateway = new RealtimeGateway({} as any, {} as any, {} as any, prisma, {} as any);
    expect(await gateway.messageNotificationState('conv', 'org')).toEqual({ mutedUntil: '9999-12-31T23:59:59.000Z', suppressNotifications: true });
    prisma.conversation.findFirst.mockResolvedValue(null);
    expect(await gateway.messageNotificationState('conv', 'org')).toEqual({ mutedUntil: null, suppressNotifications: false });
    prisma.conversation.findFirst.mockRejectedValueOnce(new Error('db'));
    await expect(gateway.messageNotificationState('conv', 'org')).rejects.toThrow('db');
  });
});
