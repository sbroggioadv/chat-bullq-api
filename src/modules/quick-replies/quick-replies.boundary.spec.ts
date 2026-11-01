import { NotFoundException } from '@nestjs/common';
import { QuickRepliesRepository } from './quick-replies.repository';
import { QuickRepliesService } from './quick-replies.service';

describe('quick reply scoped lookup', () => {
  it('filters the lookup by organization and user', async () => {
    const prisma = { quickReply: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new QuickRepliesService(new QuickRepliesRepository(prisma as any));
    await expect(service.findOne('reply-b', 'org-a', 'user-a')).rejects.toThrow(NotFoundException);
    expect(prisma.quickReply.findFirst).toHaveBeenCalledWith({ where: { id: 'reply-b', organizationId: 'org-a', deletedAt: null, OR: [{ userId: 'user-a' }, { userId: null }] } });
  });
  it('allows an organization-wide reply', async () => {
    const row = { id: 'reply-a', organizationId: 'org-a', userId: null };
    const prisma = { quickReply: { findFirst: jest.fn().mockResolvedValue(row) } };
    const service = new QuickRepliesService(new QuickRepliesRepository(prisma as any));
    await expect(service.findOne('reply-a', 'org-a', 'user-a')).resolves.toEqual(row);
  });
});
