import { RatingsService } from './ratings.service';

describe('public rating token', () => {
  it('permits exactly one concurrent submission and returns no conversation data', async () => {
    let responded = false;
    const rating = { id: 'r', respondedAt: null, conversationId: 'private' };
    const prisma: any = { conversationRating: {
      findUnique: jest.fn(async ({ select }) => select ? { id: 'r', score: 5, respondedAt: new Date() } : rating),
      update: jest.fn().mockResolvedValue({ id: 'r', score: 5, respondedAt: new Date() }),
      updateMany: jest.fn(async () => { if (responded) return { count: 0 }; responded = true; return { count: 1 }; }),
    } };
    const service = new RatingsService(prisma);
    const results = await Promise.allSettled([service.submitByToken('token', 5), service.submitByToken('token', 5)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(JSON.stringify(results.find(r => r.status === 'fulfilled'))).not.toContain('private');
  });
});
