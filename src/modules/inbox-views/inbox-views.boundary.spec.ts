import { NotFoundException } from '@nestjs/common';
import { InboxViewsService } from './inbox-views.service';

describe('inbox view organization boundary', () => {
  it('returns 404 for a view from another organization', async () => {
    const prisma = { inboxView: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new InboxViewsService(prisma as any, {} as any);
    await expect(service.findOne('view-b', 'org-a', 'user')).rejects.toThrow(NotFoundException);
    expect(prisma.inboxView.findFirst).toHaveBeenCalledWith({ where: { id: 'view-b', organizationId: 'org-a', userId: 'user' } });
  });

  it('preserves a view owned by the user in the active organization', async () => {
    const view = { id: 'view-a', organizationId: 'org-a', userId: 'user' };
    const prisma = { inboxView: { findFirst: jest.fn().mockResolvedValue(view) } };
    const service = new InboxViewsService(prisma as any, {} as any);
    await expect(service.findOne('view-a', 'org-a', 'user')).resolves.toEqual(view);
  });
});

describe('saved inbox channel references', () => {
  const prisma = {
    channel: { findMany: jest.fn() },
    inboxView: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  const service = new InboxViewsService(prisma as any, {} as any);
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.channel.findMany.mockImplementation(async ({ where }: any) => where.id.in.filter((id: string) => id === 'canal-proprio').map((id: string) => ({ id })));
    prisma.inboxView.findFirst.mockResolvedValue({ id: 'visao' });
    prisma.inboxView.create.mockResolvedValue({ ok: true });
    prisma.inboxView.update.mockResolvedValue({ ok: true });
  });
  it.each(['canal-outro', 'inexistente'])('recusa %s ao criar e editar', async (id) => {
    await expect(service.create('espaco', 'usuario', { name: 'Teste', filters: { channelIds: [id] } })).rejects.toThrow(NotFoundException);
    await expect(service.update('visao', 'espaco', 'usuario', { filters: { channelIds: [id] } })).rejects.toThrow(NotFoundException);
    expect(prisma.inboxView.create).not.toHaveBeenCalled();
    expect(prisma.inboxView.update).not.toHaveBeenCalled();
  });
  it('aceita canal próprio ao criar e editar', async () => {
    await expect(service.create('espaco', 'usuario', { name: 'Teste', filters: { channelIds: ['canal-proprio'] } })).resolves.toEqual({ ok: true });
    await expect(service.update('visao', 'espaco', 'usuario', { filters: { channelIds: ['canal-proprio'] } })).resolves.toEqual({ ok: true });
    expect(prisma.channel.findMany).toHaveBeenCalledWith({ where: { id: { in: ['canal-proprio'] }, organizationId: 'espaco', deletedAt: null }, select: { id: true } });
  });
});
