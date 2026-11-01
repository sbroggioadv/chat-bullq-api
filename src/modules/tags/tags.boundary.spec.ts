import { TagsRepository } from './tags.repository';
import { TagsService } from './tags.service';
import { NotFoundException } from '@nestjs/common';

describe('tag organization query', () => {
  it('filters the lookup itself by organization', async () => {
    const prisma = { tag: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new TagsService(new TagsRepository(prisma as any), {} as any, {} as any);
    await expect(service.findOne('tag-b', 'org-a')).rejects.toThrow(NotFoundException);
    expect(prisma.tag.findFirst).toHaveBeenCalledWith({ where: { id: 'tag-b', organizationId: 'org-a' } });
  });
  it('returns a tag belonging to the active organization', async () => {
    const tag = { id: 'tag-a', organizationId: 'org-a' };
    const prisma = { tag: { findFirst: jest.fn().mockResolvedValue(tag), findUnique: jest.fn().mockResolvedValue(tag) } };
    const service = new TagsService(new TagsRepository(prisma as any), {} as any, {} as any);
    await expect(service.findOne('tag-a', 'org-a')).resolves.toEqual(tag);
  });
});
