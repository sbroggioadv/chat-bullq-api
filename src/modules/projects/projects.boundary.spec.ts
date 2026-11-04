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
    await expect(service.getForConversation('org-a', 'conv-b', 'ALL')).rejects.toThrow(NotFoundException);
    expect(prisma.projectConversation.findFirst).not.toHaveBeenCalled();
  });

  it('returns the empty result for a valid unlinked conversation', async () => {
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv-a', isGroup: false }) },
      projectConversation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new ProjectsService(prisma as any, {} as any);
    await expect(service.getForConversation('org-a', 'conv-a', 'ALL')).resolves.toMatchObject({ exists: false });
  });
});

describe('project child deletion boundary', () => {
  it.each([
    ['removeTask', 'projectTask'],
    ['removeAttachment', 'projectAttachment'],
    ['removeContact', 'projectContact'],
  ] as const)('returns 404 when %s targets a child outside the project', async (method, model) => {
    const prisma: any = { [model]: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    const service = new ProjectsService(prisma, {} as any);
    jest.spyOn(service, 'getById').mockResolvedValue({ id: 'project-a' } as any);
    await expect(service[method]('org-a', 'project-a', 'foreign-child')).rejects.toThrow(NotFoundException);
  });

  it.each([
    ['removeTask', 'projectTask'],
    ['removeAttachment', 'projectAttachment'],
    ['removeContact', 'projectContact'],
  ] as const)('keeps legitimate %s working', async (method, model) => {
    const prisma: any = { [model]: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const service = new ProjectsService(prisma, {} as any);
    jest.spyOn(service, 'getById').mockResolvedValue({ id: 'project-a' } as any);
    await expect(service[method]('org-a', 'project-a', 'child-a')).resolves.toEqual({ id: 'project-a' });
    expect(prisma[model].deleteMany).toHaveBeenCalledWith({ where: { id: 'child-a', projectId: 'project-a' } });
  });
});
