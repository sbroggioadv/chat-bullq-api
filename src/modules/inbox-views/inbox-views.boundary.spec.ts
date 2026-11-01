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
