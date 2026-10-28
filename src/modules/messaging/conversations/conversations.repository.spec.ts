import { ConversationsRepository } from './conversations.repository';

describe('ConversationsRepository — L2', () => {
  const conversations = Array.from({ length: 30 }, (_, i) => ({
    id: `conv-${i}`, createdAt: new Date(),
  }));
  let prisma: any;
  let repository: ConversationsRepository;

  beforeEach(() => {
    prisma = {
      conversation: {
        findMany: jest.fn().mockResolvedValue(conversations),
        count: jest.fn().mockResolvedValue(30),
        findUnique: jest.fn().mockImplementation(async (args) => ({
          id: 'conv-0',
          channel: args.include.channel === true
            ? { id: 'channel', type: 'GMAIL', name: 'Mail', config: { token: 'secret' }, webhookSecret: 'secret' }
            : { id: 'channel', type: 'GMAIL', name: 'Mail' },
        })),
      },
      $transaction: jest.fn((queries) => Promise.all(queries)),
      $queryRaw: jest.fn().mockResolvedValue([{ conversation_id: 'conv-0', unread_count: 3 }]),
      conversationRead: { findMany: jest.fn().mockResolvedValue([]) },
      message: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    repository = new ConversationsRepository(prisma);
  });

  it('counts 30 conversations in one parameterized query, preserving order and zero counts', async () => {
    const result = await repository.findInbox({ organizationId: 'org' }, 0, 30, 'user');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.message.count).not.toHaveBeenCalled();
    expect(prisma.message.groupBy).not.toHaveBeenCalled();
    expect(prisma.conversationRead.findMany).not.toHaveBeenCalled();
    expect(result.conversations.map((c) => c.unreadCount)).toEqual([3, ...Array(29).fill(0)]);
    const query = prisma.$queryRaw.mock.calls[0][0];
    expect(query.values).toEqual(expect.arrayContaining(['user', ...conversations.map((c) => c.id)]));
    expect(query.sql).toContain("m.direction = 'INBOUND'");
    expect(query.sql).toContain("mo.direction = 'OUTBOUND'");
    expect(query.sql).toContain('m.created_at > cr.last_read_at');
    expect(query.sql).toContain('m.created_at > lo.last_outbound_at');
  });

  it('does not query unread counts for an empty page or without a user', async () => {
    await repository.findInbox({ organizationId: 'org' }, 0, 30);
    prisma.conversation.findMany.mockResolvedValue([]);
    await repository.findInbox({ organizationId: 'org' }, 0, 30, 'user');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('selects only id, type and name from the channel in conversation details', async () => {
    const result = await repository.findById('conv-0');
    expect(result?.channel).toEqual({ id: 'channel', type: 'GMAIL', name: 'Mail' });
    expect(prisma.conversation.findUnique.mock.calls[0][0].include.channel).toEqual({
      select: { id: true, type: true, name: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/config|webhookSecret|secret/);
  });
});
