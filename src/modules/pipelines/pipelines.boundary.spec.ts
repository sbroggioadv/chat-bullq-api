import { NotFoundException } from '@nestjs/common';
import { PipelinesService } from './pipelines.service';

describe('pipeline stage organization boundary', () => {
  function setup(stage: any) {
    const tx = {
      pipelineStage: {
        findFirst: jest.fn().mockResolvedValue(stage),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'stage-a' }),
      },
    };
    const prisma = {
      pipeline: { findUnique: jest.fn().mockResolvedValue({ id: 'pipeline-a', organizationId: 'org-a' }) },
      $transaction: jest.fn((fn) => fn(tx)),
    };
    return { service: new PipelinesService(prisma as any, {} as any), tx };
  }

  it('does not update a stage from another pipeline', async () => {
    const { service, tx } = setup(null);
    await expect(service.upsertStages('pipeline-a', 'org-a', [{ id: 'stage-b', name: 'changed' }]))
      .rejects.toThrow(NotFoundException);
    expect(tx.pipelineStage.update).not.toHaveBeenCalled();
  });

  it('updates a stage belonging to the selected pipeline', async () => {
    const { service, tx } = setup({ id: 'stage-a' });
    await service.upsertStages('pipeline-a', 'org-a', [{ id: 'stage-a', name: 'changed' }]);
    expect(tx.pipelineStage.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'stage-a', pipelineId: 'pipeline-a' } }));
  });
});
