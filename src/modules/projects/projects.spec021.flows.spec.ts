import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Reflector } from '@nestjs/core';

const group = (id: string, channelId: string, jid: string) => ({ id, organizationId: 'org', isGroup: true, channelId, contact: { channels: [{ channelId, externalId: jid }] } });
const individual = { id: 'individual', organizationId: 'org', isGroup: false, channelId: 'ch1', contact: { channels: [] } };

describe('SPEC-021 project flows', () => {
  it('resolves individuals, group legacy links, and the latest project kind', async () => {
    const conversations = [individual, group('group1', 'ch1', '1@g.us'), group('group2', 'ch2', '1@g.us'), group('other', 'ch1', '2@g.us')];
    const project = (id: string, kind: string, groupJid: string | null = null) => ({ id, groupJid, kind });
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue(conversations.filter(c => c.isGroup).map(c => ({ id: c.id, channelId: c.channelId, jid: c.contact.channels[0].externalId }))),
      projectConversation: { findMany: jest.fn().mockResolvedValue([
        { conversationId: 'individual', conversation: { channelId: 'ch1' }, project: project('a', 'MENTORSHIP') },
        { conversationId: 'group1', conversation: { channelId: 'ch1' }, project: project('b', 'PROJECT') },
      ]) },
      project: { findMany: jest.fn().mockResolvedValue([project('old', 'MENTORSHIP', '1@g.us')]) },
    };
    const service = new ProjectsService(prisma, {} as any);
    jest.spyOn(service, 'toDetail').mockImplementation((p: any) => p);
    expect((await service.resolveFilter('org', { kind: 'ANY' })).representativeIds).toEqual(['individual', 'group1', 'group2']);
    expect((await service.resolveFilter('org', { kind: 'MENTORSHIP' })).representativeIds).toEqual(['individual', 'group2']);
  });

  it('removes one project for the whole group and preserves another group and tasks', async () => {
    const conversations = [group('group1', 'ch1', '1@g.us'), group('group2', 'ch2', '1@g.us'), group('other', 'ch1', '2@g.us')];
    const project: any = { id: 'p', groupJid: '1@g.us', deletedAt: null };
    let links = [{ projectId: 'p', conversationId: 'group1' }, { projectId: 'p', conversationId: 'other' }, { projectId: 'another', conversationId: 'group1' }];
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue(conversations.filter(c => c.contact.channels[0].externalId === '1@g.us').map(c => ({ id: c.id, channelId: c.channelId, jid: '1@g.us' }))),
      conversation: { findFirst: jest.fn(async () => conversations[0]), findMany: jest.fn(async () => conversations) },
      projectConversation: {
        findFirst: jest.fn(async ({ where }: any) => links.find(l => l.conversationId === where.conversationId && (!where.projectId || l.projectId === where.projectId))),
        findMany: jest.fn(async ({ where }: any) => links.filter(l => l.projectId === where.projectId && where.conversationId.in.includes(l.conversationId))),
        deleteMany: jest.fn(async ({ where }: any) => { links = links.filter(l => l.projectId !== where.projectId || !where.conversationId.in.includes(l.conversationId)); }),
      },
      project: {
        findFirst: jest.fn(async ({ select }: any) => select ? { groupJid: project.groupJid, _count: { conversations: links.filter(l => l.projectId === 'p').length, tasks: 1, attachments: 0 } } : project),
        update: jest.fn(async ({ data }: any) => Object.assign(project, data)),
      },
    };
    const service = new ProjectsService({ ...tx, $transaction: (fn: any) => fn(tx) } as any, {} as any);
    await expect(service.removeForConversation('org', 'group1', 'p', 'ALL')).resolves.toEqual({ projectId: 'p', removedConversations: 2 });
    expect(project.groupJid).toBeNull();
    expect(project.deletedAt).toBeNull();
    expect(links).toEqual([{ projectId: 'p', conversationId: 'other' }, { projectId: 'another', conversationId: 'group1' }]);
    jest.spyOn(service, 'getById').mockImplementation(async (_org, id) => ({ id, exists: true } as any));
    expect(await service.getForConversation('org', 'group1')).toMatchObject({ id: 'another', exists: true });
    tx.projectConversation.findMany.mockImplementation(async () => links.map(l => ({ ...l, conversation: { channelId: 'ch1' }, project: { id: l.projectId, kind: 'PROJECT' } })));
    tx.project.findMany = jest.fn().mockResolvedValue([]);
    jest.spyOn(service, 'toDetail').mockImplementation((p: any) => p);
    expect((await service.resolveFilter('org', { kind: 'ANY' })).representativeIds).toEqual(['other', 'group1']);
    expect((await service.resolveFilter('org', { kind: 'MENTORSHIP' })).representativeIds).toEqual([]);
  });

  it('allows any member to invoke PUT with kind', async () => {
    const service: any = { updateForConversation: jest.fn().mockResolvedValue({ kind: 'MENTORSHIP' }) };
    const controller = new ProjectsController(service);
    expect(Reflect.getMetadata(ROLES_KEY, controller.updateByConversation)).toBeUndefined();
    const guard = new RolesGuard(new Reflector());
    for (const role of ['AGENT', 'ADMIN', 'OWNER']) {
      expect(guard.canActivate({ getHandler: () => controller.updateByConversation, getClass: () => ProjectsController, switchToHttp: () => ({ getRequest: () => ({ organization: { userRole: role } }) }) } as any)).toBe(true);
    }
    await controller.updateByConversation('conversation', 'org', { name: 'Synthetic', metadata: { kind: 'MENTORSHIP' } });
    expect(service.updateForConversation).toHaveBeenCalledWith('org', 'conversation', { name: 'Synthetic', metadata: { kind: 'MENTORSHIP' } });
  });

  it('soft deletes an empty project after unlinking an individual', async () => {
    const tx: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(individual) },
      projectConversation: {
        findFirst: jest.fn().mockResolvedValue({ projectId: 'p' }),
        findMany: jest.fn().mockResolvedValue([{ conversationId: 'individual' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      project: {
        findFirst: jest.fn(async ({ select }: any) => select
          ? { groupJid: null, _count: { conversations: 0, tasks: 0, attachments: 0 } }
          : { id: 'p', groupJid: null }),
        update: jest.fn(),
      },
    };
    const service = new ProjectsService({ $transaction: (fn: any) => fn(tx) } as any, {} as any);
    await expect(service.removeForConversation('org', 'individual', undefined, 'ALL')).resolves.toEqual({ projectId: 'p', removedConversations: 1 });
    expect(tx.project.update).toHaveBeenCalledWith({ where: { id: 'p' }, data: { deletedAt: expect.any(Date) } });
  });

  it('retains a project whose only remaining content is a task', async () => {
    const tx: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(individual) },
      projectConversation: { findFirst: jest.fn().mockResolvedValue({ projectId: 'p' }), findMany: jest.fn().mockResolvedValue([{ conversationId: 'individual' }]), deleteMany: jest.fn() },
      project: { findFirst: jest.fn(async ({ select }: any) => select ? { groupJid: null, _count: { conversations: 0, tasks: 1, attachments: 0 } } : { id: 'p', groupJid: null }), update: jest.fn() },
    };
    const service = new ProjectsService({ $transaction: (fn: any) => fn(tx) } as any, {} as any);
    await service.removeForConversation('org', 'individual', undefined, 'ALL');
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it('excludes deleted projects from explicit and legacy project lookups', async () => {
    const prisma: any = { projectConversation: { findMany: jest.fn().mockResolvedValue([]) }, project: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new ProjectsService(prisma, {} as any);
    await service.attachByConversationIds('org', ['individual']);
    await service.attachByJids('org', ['1@g.us']);
    expect(prisma.projectConversation.findMany.mock.calls[0][0].where.project).toMatchObject({ organizationId: 'org', deletedAt: null });
    expect(prisma.project.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: 'org', deletedAt: null });
  });
});
