import { NotFoundException } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';

describe('marcação de notificação', () => {
  it('passa usuário e organização ativos desde o controlador', async () => {
    const service = { markRead: jest.fn() };
    (new NotificationsController(service as any) as any).markRead('n-b', 'user-a', 'org-a');
    expect(service.markRead).toHaveBeenCalledWith('n-b', 'user-a', 'org-a');
  });
  it('nega notificação fora da organização ou de outro destinatário', async () => {
    const update = jest.fn(async ({ where }: any) => { if (where.organizationId !== 'org-b' || where.recipientId !== 'user-b') throw Object.assign(new Error('missing'), { code: 'P2025' }); return { id: 'n-b', isRead: true }; });
    const repo = new NotificationsRepository({ notification: { update } } as any);
    await expect((repo as any).markRead('n-b', 'user-a', 'org-a')).rejects.toBeInstanceOf(NotFoundException);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'n-b', recipientId: 'user-a', organizationId: 'org-a' } }));
  });
  it('marca a notificação legítima e preserva o retorno', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'n-a', isRead: true });
    const repo = new NotificationsRepository({ notification: { update } } as any);
    await expect((repo as any).markRead('n-a', 'user-a', 'org-a')).resolves.toEqual({ id: 'n-a', isRead: true });
  });
});
