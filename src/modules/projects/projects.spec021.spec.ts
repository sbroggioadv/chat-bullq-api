import { BadRequestException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

describe('SPEC-021 project kind', () => {
  const project: any = { id: 'p1', organizationId: 'org1', name: 'Synthetic', metadata: {}, responsible: null, conversations: [], tasks: [], attachments: [], contacts: [] };
  const prisma: any = { project: { findFirst: jest.fn(async () => project), findUnique: jest.fn(async () => project), update: jest.fn(async () => project) } };
  const service = new ProjectsService(prisma, {} as any);
  it('normalizes absent kind as PROJECT', () => {
    expect(service.toDetail(project)).toMatchObject({ kind: 'PROJECT' });
  });
  it('rejects invalid kind before writing', async () => {
    await expect(service.update('org1', 'p1', { metadata: { kind: 'INVALID' } })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});
