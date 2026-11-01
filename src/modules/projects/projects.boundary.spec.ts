import { NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

describe('project conversation organization boundary', () => {
  it('rejects foreign conversation ids before creating a project', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue(null) }, project: { create: jest.fn() } };
    const service = new ProjectsService(prisma as any, {} as any);
    await expect(service.create('org-a', { name: 'Project', conversationId: 'conv-b' })).rejects.toThrow(NotFoundException);
    expect(prisma.project.create).not.toHaveBeenCalled();
  });

  it('rejects foreign conversation ids before looking up project links', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue(null) }, projectConversation: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new ProjectsService(prisma as any, {} as any);
    await expect(service.getForConversation('org-a', 'conv-b')).rejects.toThrow(NotFoundException);
    expect(prisma.projectConversation.findFirst).not.toHaveBeenCalled();
  });

  it('returns the empty result for a valid unlinked conversation', async () => {
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv-a', isGroup: false }) },
      projectConversation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new ProjectsService(prisma as any, {} as any);
    await expect(service.getForConversation('org-a', 'conv-a')).resolves.toMatchObject({ exists: false });
  });
});
