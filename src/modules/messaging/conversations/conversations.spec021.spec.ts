import { ConversationsRepository } from './conversations.repository';
import { ConversationsController } from './conversations.controller';

describe('SPEC-021 conversation filters', () => {
  it('intersects search, tags, ids and channel access', async () => {
    const prisma: any = { conversation: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) }, $transaction: (queries: any[]) => Promise.all(queries) };
    const repository = new ConversationsRepository(prisma);
    await repository.findInbox({ organizationId: 'org', conversationIds: ['c1'], accessibleChannelIds: ['allowed'], search: 'example', tagIds: ['tag'] }, 0, 20);
    const where = prisma.conversation.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ in: ['c1'] });
    expect(where.channelId).toEqual({ in: ['allowed'] });
    expect(JSON.stringify(where)).toContain('tagId');
    expect(JSON.stringify(where)).toContain('example');
    expect(where.AND).toEqual(expect.arrayContaining([expect.objectContaining({ OR: expect.any(Array) })]));
  });
  it('passes valid ids to the service and rejects invalid ids', () => {
    const service: any = { findInbox: jest.fn() };
    const controller = new ConversationsController(service);
    const invoke = (ids: string) => (controller.findInbox as any)('org', 'user', 'ALL', ...Array(15).fill(undefined), ids);
    invoke('ck12345678901234567890123');
    expect(service.findInbox.mock.calls[0][1].conversationIds).toEqual(['ck12345678901234567890123']);
    expect(() => invoke('bad!')).toThrow();
    expect(() => invoke(Array(21).fill('ck12345678901234567890123').join(','))).toThrow();
  });
  it('does not return requested ids outside accessible channels or organization', async () => {
    const rows = [
      { id: 'a', organizationId: 'org', channelId: 'allowed' },
      { id: 'b', organizationId: 'org', channelId: 'denied' },
      { id: 'c', organizationId: 'other', channelId: 'allowed' },
    ];
    const prisma: any = { conversation: {
      findMany: jest.fn(async ({ where }: any) => rows.filter(row => row.organizationId === where.organizationId && where.id.in.includes(row.id) && where.channelId.in.includes(row.channelId))),
      count: jest.fn().mockResolvedValue(1),
    }, $transaction: (queries: any[]) => Promise.all(queries) };
    const result = await new ConversationsRepository(prisma).findInbox({ organizationId: 'org', conversationIds: ['a', 'b', 'c'], accessibleChannelIds: ['allowed'] }, 0, 20);
    expect(result.conversations.map(c => c.id)).toEqual(['a']);
  });
});
