import { ProjectsService } from './projects.service';

describe('SPEC-021 R3', () => {
  it('restringe a consulta de JIDs aos canais da organização, inclusive excluídos', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const prisma: any = {
      projectConversation: { findMany: jest.fn().mockResolvedValue([]) },
      project: { findMany: jest.fn().mockResolvedValue([{ groupJid: '1@g.us' }]) },
      $queryRaw: query,
    };
    const service = new ProjectsService(prisma, {} as any);
    jest.spyOn(service, 'toDetail').mockReturnValue({ kind: 'PROJECT' } as any);
    await service.resolveFilter('org', { kind: 'ANY' });
    const sql = query.mock.calls[0][0].join('?');
    expect(sql).toMatch(/cc\.channel_id\s+IN\s*\(\s*SELECT id FROM channels WHERE organization_id\s*=\s*\?/i);
    expect(sql).not.toMatch(/FROM channels WHERE[^)]*deleted_at/i);
    expect(query.mock.calls[0]).toContain('org');
  });
  it('remove por JID sem carregar todas as conversas da organização', async () => {
    const conversation = { id: 'c', isGroup: true, channelId: 'ch', contact: { channels: [{ channelId: 'ch', externalId: '1@g.us' }] } };
    const tx: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(conversation), findMany: jest.fn(() => { throw new Error('varredura integral'); }) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'c', channelId: 'ch', jid: '1@g.us' }]),
      projectConversation: { findFirst: jest.fn().mockResolvedValue({ projectId: 'p' }), findMany: jest.fn().mockResolvedValue([{ conversationId: 'c' }]), deleteMany: jest.fn() },
      project: { findFirst: jest.fn(async ({ select }: any) => select ? { groupJid: null, _count: { conversations: 0, tasks: 1, attachments: 0 } } : { id: 'p', groupJid: '1@g.us' }), update: jest.fn() },
    };
    const service = new ProjectsService({ $transaction: (fn: any) => fn(tx) } as any, {} as any);
    await expect(service.removeForConversation('org', 'c', undefined, 'ALL')).resolves.toEqual({ projectId: 'p', removedConversations: 1 });
    expect(tx.conversation.findMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
