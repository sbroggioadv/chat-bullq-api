import { NotFoundException } from '@nestjs/common';
import { ChannelAccessService } from './channel-access.service';

describe('channel grant removal organization boundary', () => {
  it('rejects a foreign channel before deleting grants', async () => {
    const prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue(null) },
      userOrganization: { findUnique: jest.fn().mockResolvedValue({ id: 'membership-a', userId: 'user-a' }) },
      channelAgent: { deleteMany: jest.fn() },
    };
    const service = new ChannelAccessService(prisma as any);
    await expect(service.removeChannelAgent('org-a', 'channel-b', 'user-a')).rejects.toThrow(NotFoundException);
    expect(prisma.channelAgent.deleteMany).not.toHaveBeenCalled();
  });

  it('continues to remove a grant on an owned channel', async () => {
    const prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'channel-a' }) },
      userOrganization: { findUnique: jest.fn().mockResolvedValue({ id: 'membership-a', userId: 'user-a' }) },
      channelAgent: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new ChannelAccessService(prisma as any);
    await expect(service.removeChannelAgent('org-a', 'channel-a', 'user-a')).resolves.toEqual({ userId: 'user-a' });
    expect(prisma.channelAgent.deleteMany).toHaveBeenCalledWith({ where: { channelId: 'channel-a', userOrganizationId: 'membership-a' } });
  });
});
