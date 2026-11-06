import { BadRequestException } from '@nestjs/common';
import { InboxViewsController } from './inbox-views.controller';
import { InboxViewsService } from './inbox-views.service';

describe('saved inbox projectKind', () => {
  const access = new Set(['channel-a']);
  const result = { data: [], total: 0 };
  const prisma = {
    inboxView: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'view',
        filters: { channelIds: ['channel-a'], unreadOnly: true, kind: 'GROUP' },
      }),
    },
  };
  const conversations = { findInbox: jest.fn().mockResolvedValue(result) };
  const service = new InboxViewsService(prisma as any, conversations as any);
  const controller = new InboxViewsController(service);
  const request = (projectKind?: string) =>
    (controller.conversations as (...args: any[]) => any)(
      'view', 'org', 'user', access, '2', '10', 'busca',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      projectKind,
    );

  beforeEach(() => jest.clearAllMocks());

  it.each(['MENTORSHIP', 'ANY', undefined])(
    'propaga %s do controller até findInbox e preserva os filtros salvos',
    async (projectKind) => {
      await expect(request(projectKind)).resolves.toBe(result);
      expect(prisma.inboxView.findFirst).toHaveBeenCalledWith({
        where: { id: 'view', organizationId: 'org', userId: 'user' },
      });
      expect(conversations.findInbox).toHaveBeenCalledWith(
        'org', {
          status: undefined, channelIds: ['channel-a'], conversationIds: undefined,
          kind: 'GROUP', tagIds: undefined, assignedToId: undefined,
          search: 'busca', archived: undefined, unreadOnly: true,
          stuckOnly: undefined, projectKind,
        }, 2, 10, access, 'user',
      );
    },
  );

  it.each(['INVALID', '', 'mentorship'])('recusa %j com 400 antes de consultar a view', (value) => {
    expect.assertions(5);
    try {
      request(value);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
      expect((error as Error).message).toBe('projectKind inválido');
    }
    expect(prisma.inboxView.findFirst).not.toHaveBeenCalled();
    expect(conversations.findInbox).not.toHaveBeenCalled();
  });

  it('preserva a chamada do service sem overrides', async () => {
    await expect(service.findConversations('view', 'org', 'user', access, 1, 20)).resolves.toBe(result);
    expect(conversations.findInbox).toHaveBeenCalledWith(
      'org', expect.objectContaining({ channelIds: ['channel-a'], kind: 'GROUP', unreadOnly: true }),
      1, 20, access, 'user',
    );
    expect(conversations.findInbox.mock.calls[0][1].projectKind).toBeUndefined();
  });
});
