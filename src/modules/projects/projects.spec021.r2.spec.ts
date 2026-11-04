import { ProjectsService } from './projects.service';

describe('SPEC-021 R2', () => {
  it('registra o vínculo de um grupo legado ao abrir', async () => {
    const upsert = jest.fn();
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ isGroup: true, channelId: 'ch', contact: { channels: [{ channelId: 'ch', externalId: '1@g.us' }] } }) },
      projectConversation: { findFirst: jest.fn().mockResolvedValue(null), upsert },
      project: { findFirst: jest.fn().mockResolvedValue({ id: 'p' }) },
    };
    const service = new ProjectsService(prisma, {} as any);
    jest.spyOn(service, 'toDetail').mockReturnValue({} as any);
    await service.getForConversation('org', 'c');
    expect(upsert).toHaveBeenCalledWith({ where: { uq_project_conversation: { projectId: 'p', conversationId: 'c' } }, create: { projectId: 'p', conversationId: 'c' }, update: {} });
  });
  it('não varre todas as conversas para projectKind', async () => {
    const prisma: any = {
      conversation: { findMany: jest.fn(() => { throw new Error('varredura integral'); }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      projectConversation: { findMany: jest.fn().mockResolvedValue([]) },
      project: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ProjectsService(prisma, {} as any);
    await expect(service.resolveFilter('org', { kind: 'ANY' })).resolves.toEqual({ representativeIds: [], memberChannelIds: [] });
  });
  it('abre legado, remove e não recria vínculo ao reabrir', async () => {
    let jid: string | null = '1@g.us';
    let linked = false;
    const conv = { id: 'c', isGroup: true, channelId: 'ch', contact: { channels: [{ channelId: 'ch', externalId: '1@g.us' }] } };
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(conv), findMany: jest.fn().mockResolvedValue([conv]) },
      projectConversation: {
        findFirst: jest.fn(async () => linked ? { projectId: 'p' } : null),
        upsert: jest.fn(async () => { linked = true; }),
        findMany: jest.fn(async () => linked ? [{ conversationId: 'c' }] : []),
        deleteMany: jest.fn(async () => { linked = false; }),
      },
      project: {
        findFirst: jest.fn(async ({ where, select }: any) => select ? { groupJid: jid, _count: { conversations: 0, tasks: 1, attachments: 0 } } : where.groupJid && !jid ? null : { id: 'p', groupJid: jid }),
        update: jest.fn(async ({ data }: any) => { if ('groupJid' in data) jid = data.groupJid; }),
      },
    };
    prisma.$transaction = (fn: any) => fn(prisma);
    const service = new ProjectsService(prisma, {} as any);
    jest.spyOn(service, 'toDetail').mockReturnValue({ id: 'p', exists: true } as any);
    jest.spyOn(service, 'getById').mockResolvedValue({ id: 'p', exists: true } as any);
    await service.getForConversation('org', 'c');
    expect(linked).toBe(true);
    await (service.removeForConversation as any).call(service, 'org', 'c', undefined, 'ALL');
    expect(jid).toBeNull();
    expect((await service.getForConversation('org', 'c')).exists).toBe(false);
    expect(prisma.projectConversation.upsert).toHaveBeenCalledTimes(1);
  });
  it('nega remoção sem acesso ao canal antes de qualquer escrita', async () => {
    const tx: any = { conversation: { findFirst: jest.fn().mockResolvedValue({ channelId: 'privado', isGroup: false }) }, projectConversation: { findFirst: jest.fn().mockResolvedValue({ projectId: 'p' }), findMany: jest.fn().mockResolvedValue([{ conversationId: 'c' }]), deleteMany: jest.fn() }, project: { findFirst: jest.fn().mockResolvedValue({ id: 'p', groupJid: null }), update: jest.fn() } };
    const service = new ProjectsService({ $transaction: (fn: any) => fn(tx) } as any, {} as any);
    await expect((service.removeForConversation as any).call(service, 'org', 'c', undefined, new Set())).rejects.toMatchObject({ status: 403 });
    expect(tx.projectConversation.deleteMany).not.toHaveBeenCalled();
    expect(tx.project.update).not.toHaveBeenCalled();
  });
  it('mede 5.000 conversas e 20 projetos sem varredura integral', async () => {
    const all = Array.from({ length: 5000 }, (_, i) => ({ id: `c${i}`, channelId: 'ch', contact: { channels: [{ channelId: 'ch', externalId: `${i}@g.us` }] } }));
    const projects = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, groupJid: `${i}@g.us`, kind: 'PROJECT' }));
    const links = projects.map((p, i) => ({ conversationId: `c${i}`, conversation: { channelId: 'ch' }, project: p }));
    let rows = 0;
    const prisma: any = {
      projectConversation: { findMany: jest.fn(async () => { rows += links.length; return links; }) },
      project: { findMany: jest.fn(async () => { rows += projects.length; return projects; }) },
      conversation: { findMany: jest.fn(() => { throw new Error('varredura integral'); }) },
      $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...args: any[]) => {
        expect(parts.join('?')).toContain('cc.channel_id = c.channel_id');
        const jids = args[1].values;
        const result = all.filter(c => jids.includes(c.contact.channels[0].externalId)).map(c => ({ id: c.id, channelId: c.channelId, jid: c.contact.channels[0].externalId })); rows += result.length; return result;
      }),
    };
    const service = new ProjectsService(prisma, {} as any);
    jest.spyOn(service, 'toDetail').mockImplementation((p: any) => p);
    const result = await service.resolveFilter('org', { kind: 'ANY' });
    expect(result.representativeIds).toHaveLength(20);
    expect(rows).toBe(60);
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    console.log('M1 fixture sintética: 5000 conversas, 20 projetos; 3 consultas, 60 linhas retornadas');
  });

});
