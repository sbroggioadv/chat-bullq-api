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
  it.each(['SLA_WARNING', 'SLA_BREACH', 'CONVERSATION_TRANSFERRED', 'CONVERSATION_ASSIGNED', 'AI_TOOL_FAILURE', 'SYSTEM'])('preserva registro e entrega de alerta operacional %s em conversa silenciada', async type => {
    const prisma: any = { conversation: { findFirst: jest.fn().mockResolvedValue({ mutedUntil: new Date('9999-12-31') }) } };
    const repo: any = { create: jest.fn().mockResolvedValue({ id: 'notification' }) };
    const queue: any = { add: jest.fn() };
    const gateway: any = { emitToUserInOrg: jest.fn() };
    await new NotificationsService(repo, prisma, queue).notify({ ...params, type: type as any });
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(await new NotificationProcessor(gateway, prisma).process({ data: { ...params, type } } as any)).toMatchObject({ delivered: true });
    expect(gateway.emitToUserInOrg).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
  });
  it('falha na consulta não impede gravar ou entregar mensagem nova e emite aviso', async () => {
    const prisma: any = { conversation: { findFirst: jest.fn().mockRejectedValue(new Error('db')) } };
    const repo: any = { create: jest.fn().mockResolvedValue({ id: 'notification' }) };
    const queue: any = { add: jest.fn() };
    const gateway: any = { emitToUserInOrg: jest.fn() };
    const service = new NotificationsService(repo, prisma, queue);
    const processor = new NotificationProcessor(gateway, prisma);
    const serviceWarn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const processorWarn = jest.spyOn((processor as any).logger, 'warn').mockImplementation(() => undefined);
    await expect(service.notify(params)).resolves.toEqual({ id: 'notification' });
    await expect(processor.process({ data: params } as any)).resolves.toMatchObject({ delivered: true });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(gateway.emitToUserInOrg).toHaveBeenCalledTimes(1);
    expect(serviceWarn).toHaveBeenCalled();
    expect(processorWarn).toHaveBeenCalled();
  });
  it('realtime informa silêncio sem impedir emissão ou alterar a mensagem', async () => {
    const prisma: any = { conversation: { findFirst: jest.fn().mockResolvedValue({ mutedUntil: new Date('9999-12-31T23:59:59Z') }) } };
    const gateway = new RealtimeGateway({} as any, {} as any, {} as any, prisma, {} as any);
    expect(await gateway.messageNotificationState('conv', 'org')).toEqual({ mutedUntil: '9999-12-31T23:59:59.000Z', suppressNotifications: true });
    prisma.conversation.findFirst.mockResolvedValue(null);
    expect(await gateway.messageNotificationState('conv', 'org')).toEqual({ mutedUntil: null, suppressNotifications: false });
    prisma.conversation.findFirst.mockRejectedValueOnce(new Error('db'));
    await expect(gateway.messageNotificationState('conv', 'org')).resolves.toEqual({ mutedUntil: null, suppressNotifications: false });
  });
});
