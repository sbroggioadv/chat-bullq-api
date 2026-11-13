import { ProjectsService } from './projects.service';
import { ConversationsController } from '../messaging/conversations/conversations.controller';
import { InboxViewsController } from '../inbox-views/inbox-views.controller';

const detail = (metadata: unknown) => ({
  organizationId: 'org', metadata, responsible: null, conversations: [],
  contacts: [], tasks: [], attachments: [],
});

function setup(reverse = false) {
  const links = [
    { conversationId: 'project-only', project: detail({ kind: 'PROJECT' }) },
    { conversationId: 'mentorship-only', project: detail({ kind: 'MENTORSHIP' }) },
    { conversationId: 'mixed', project: detail({ kind: 'MENTORSHIP' }) },
    { conversationId: 'mixed', project: detail({ kind: 'PROJECT' }) },
    { conversationId: 'legacy', project: detail({}) },
    { conversationId: 'null-metadata', project: detail(null) },
  ].map(link => ({ ...link, conversation: { channelId: 'channel' } }));
  const prisma = {
    projectConversation: { findMany: jest.fn().mockResolvedValue(reverse ? links.reverse() : links) },
    project: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { service: new ProjectsService(prisma as any, {} as any), prisma };
}

describe('project kind filtering', () => {
  it.each([false, true])('PROJECT selects non-mentorship links regardless of link order (%s)', async reverse => {
    const { service, prisma } = setup(reverse);
    const result = await service.resolveFilter('org', { kind: 'PROJECT' as any });
    expect(result.representativeIds.sort()).toEqual(['legacy', 'mixed', 'null-metadata', 'project-only']);
    expect(result.memberChannelIds).toEqual(['channel']);
    expect(prisma.projectConversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { project: { organizationId: 'org', deletedAt: null }, conversation: { organizationId: 'org', deletedAt: null } },
    }));
  });

  it.each([false, true])('mixed links appear under both kinds without duplicates (%s)', async reverse => {
    const { service } = setup(reverse);
    for (const kind of ['PROJECT', 'MENTORSHIP'] as const) {
      const result = await service.resolveFilter('org', { kind: kind as any });
      expect(result.representativeIds.filter(id => id === 'mixed')).toHaveLength(1);
      if (kind === 'PROJECT') expect(result.representativeIds).not.toContain('mentorship-only');
    }
  });

  it('ANY and MENTORSHIP retain single-kind membership and absent metadata defaults to PROJECT', async () => {
    const { service } = setup();
    expect((await service.resolveFilter('org', { kind: 'ANY' })).representativeIds)
      .toEqual(['project-only', 'mentorship-only', 'mixed', 'legacy', 'null-metadata']);
    expect((await service.resolveFilter('org', { kind: 'MENTORSHIP' })).representativeIds)
      .toEqual(['mentorship-only', 'mixed']);
    expect((await service.resolveFilter('org', { kind: 'PROJECT' as any })).representativeIds)
      .toEqual(['project-only', 'mixed', 'legacy', 'null-metadata']);
  });
});

describe.each(['inbox', 'view'])('%s projectKind boundary', route => {
  const service = { findInbox: jest.fn(), findConversations: jest.fn() };
  const controller = route === 'inbox'
    ? new ConversationsController(service as any)
    : new InboxViewsController(service as any);
  const request = (kind: string) => route === 'inbox'
    ? (controller as ConversationsController).findInbox('org', 'user', 'ALL', ...Array(16).fill(undefined), kind)
    : (controller as InboxViewsController).conversations('view', 'org', 'user', 'ALL', ...Array(10).fill(undefined), kind);

  beforeEach(() => jest.clearAllMocks());

  it('accepts PROJECT and rejects OUTRO with 400 before service access', () => {
    request('PROJECT');
    const calls = route === 'inbox' ? service.findInbox : service.findConversations;
    expect(calls).toHaveBeenCalledWith(...(route === 'inbox'
      ? ['org', expect.objectContaining({ projectKind: 'PROJECT' }), 1, 20, 'ALL', 'user']
      : ['view', 'org', 'user', 'ALL', 1, 20, undefined, expect.objectContaining({ projectKind: 'PROJECT' })]));
    const method = route === 'inbox' ? ConversationsController.prototype.findInbox : InboxViewsController.prototype.conversations;
    expect(Reflect.getMetadata('swagger/apiParameters', method)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'projectKind', schema: { type: 'string', enum: ['ANY', 'PROJECT', 'MENTORSHIP'] } }),
    ]));
    calls.mockClear();
    try {
      request('OUTRO');
      throw new Error('Expected invalid projectKind to fail');
    } catch (error) {
      expect(error).toMatchObject({ status: 400 });
    }
    expect(calls).not.toHaveBeenCalled();
  });
});
