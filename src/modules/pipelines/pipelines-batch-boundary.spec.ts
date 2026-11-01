import { PipelinesService } from './pipelines.service';

describe('pipeline batch organization boundary', () => {
  it('lists only cards of the active organization while keeping its own cards', async () => {
    const cards = [
      { id: 'own', organizationId: 'a', stageId: 's' },
      { id: 'foreign', organizationId: 'b', stageId: 's' },
    ];
    const prisma: any = {
      pipeline: { findFirst: jest.fn().mockResolvedValue({ id: 'p', organizationId: 'a' }) },
      pipelineStage: { findMany: jest.fn().mockResolvedValue([{ id: 's' }]) },
      card: { findMany: jest.fn(({ where }) => Promise.resolve(cards.filter(c => c.organizationId === where.organizationId))) },
      $transaction: jest.fn((queries) => Promise.all(queries)),
    };
    const result = await new PipelinesService(prisma, {} as any).getBoard('p', 'a');
    expect(result.cards.s.map((c: any) => c.id)).toEqual(['own']);
    expect(prisma.card.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { pipelineId: 'p', organizationId: 'a' } }));
  });
});
