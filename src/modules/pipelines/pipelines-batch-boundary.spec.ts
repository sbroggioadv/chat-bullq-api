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
  it.each([[0, 2, 's'], [2, 0, 's'], [0, 1, 'other']])(
    'reorders only active-organization cards for %s to %s',
    async (from, to, target) => {
      const tx: any = { card: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}) } };
      const prisma: any = {
        card: { findUnique: jest.fn().mockResolvedValue({ id: 'c', organizationId: 'a', pipelineId: 'p', stageId: 's', order: from, status: 'OPEN', closedAt: null }) },
        pipelineStage: { findUnique: jest.fn().mockResolvedValue({ id: target, pipelineId: 'p', type: 'NORMAL' }) },
        $transaction: jest.fn((callback) => callback(tx)),
      };
      await new PipelinesService(prisma, { emitToOrg: jest.fn() } as any).moveCard('c', 'a', { toStageId: target, toIndex: to });
      expect(tx.card.updateMany).toHaveBeenCalled();
      for (const [query] of tx.card.updateMany.mock.calls) expect(query.where.organizationId).toBe('a');
      expect(tx.card.update).toHaveBeenCalled();
    },
  );

});
