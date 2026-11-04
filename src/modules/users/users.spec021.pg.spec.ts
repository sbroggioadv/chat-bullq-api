import { PrismaClient } from '@prisma/client';
import { UsersService } from './users.service';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';

const url = process.env.SPEC021_PG_URL;
const suite = url ? describe : describe.skip;

suite('SPEC-021: concorrência no PostgreSQL descartável', () => {
  let db: PrismaClient;
  let service: UsersService;
  const run = `synthetic-${process.pid}-${Date.now()}`;
  const ids = Array.from({ length: 22 }, (_, i) => `${run}-c${i}`);
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/spec021') throw new Error('Use apenas banco local descartável spec021');
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.organization.create({ data: { id: `${run}-org`, name: 'Synthetic', slug: `${run}-org` } });
    await db.user.create({ data: { id: `${run}-user`, name: 'Synthetic', email: `${run}@example.test`, password: 'synthetic' } });
    await db.userOrganization.create({ data: { id: `${run}-membership`, userId: `${run}-user`, organizationId: `${run}-org` } });
    await db.channel.create({ data: { id: `${run}-channel`, organizationId: `${run}-org`, name: 'Synthetic', type: 'WHATSAPP_ZAPPFY', config: {} } });
    await db.contact.create({ data: { id: `${run}-contact`, organizationId: `${run}-org` } });
    for (const id of ids) await db.conversation.create({ data: { id, organizationId: `${run}-org`, channelId: `${run}-channel`, contactId: `${run}-contact` } });
    service = new UsersService(db as any, new ChannelAccessService(db as any));
  });
  beforeEach(async () => {
    await db.userOrganization.update({ where: { id: `${run}-membership` }, data: { preferences: {} } });
  });
  afterAll(async () => { await db?.$disconnect(); });
  const pin = (id: string) => service.setPinned(`${run}-user`, `${run}-org`, id, true, 'ALL');
  const prefs = () => service.getPreferences(`${run}-user`, `${run}-org`) as Promise<any>;
  it('mantém duas fixações concorrentes', async () => {
    await Promise.all([pin(ids[0]), pin(ids[1])]);
    expect((await prefs()).pinnedConversations.map((p: any) => p.id).sort()).toEqual(ids.slice(0, 2).sort());
  });
  it('recusa a 21ª fixação', async () => {
    for (const id of ids.slice(0, 20)) await pin(id);
    await expect(pin(ids[20])).rejects.toThrow('pin_limit_reached');
    expect((await prefs()).pinnedConversations).toHaveLength(20);
  });
  it('PATCH concorrente preserva as fixadas', async () => {
    await pin(ids[0]);
    await Promise.all([pin(ids[1]), service.updatePreferences(`${run}-user`, `${run}-org`, { inbox: { scope: 'MINE' }, pinnedConversations: [] })]);
    const result = await prefs();
    expect(result.inbox).toEqual({ scope: 'MINE' });
    expect(result.pinnedConversations.map((p: any) => p.id).sort()).toEqual(ids.slice(0, 2).sort());
  });
  it('remove uma fantasma antes de aplicar o teto', async () => {
    for (const id of ids.slice(0, 20)) await pin(id);
    await db.conversation.update({ where: { id: ids[0] }, data: { deletedAt: new Date() } });
    await pin(ids[20]);
    const result = (await prefs()).pinnedConversations.map((p: any) => p.id);
    expect(result).toHaveLength(20);
    expect(result).not.toContain(ids[0]);
    expect(result).toContain(ids[20]);
    await db.conversation.update({ where: { id: ids[0] }, data: { deletedAt: null } });
  });
  it('poda entradas de outra organização e de canal sem acesso', async () => {
    await db.organization.create({ data: { id: `${run}-other-org`, name: 'Synthetic', slug: `${run}-other-org` } });
    await db.channel.create({ data: { id: `${run}-other-channel`, organizationId: `${run}-org`, name: 'Synthetic', type: 'WHATSAPP_ZAPPFY', config: {} } });
    await db.channel.create({ data: { id: `${run}-foreign-channel`, organizationId: `${run}-other-org`, name: 'Synthetic', type: 'WHATSAPP_ZAPPFY', config: {} } });
    await db.contact.create({ data: { id: `${run}-foreign-contact`, organizationId: `${run}-other-org` } });
    await db.conversation.create({ data: { id: `${run}-denied`, organizationId: `${run}-org`, channelId: `${run}-other-channel`, contactId: `${run}-contact` } });
    await db.conversation.create({ data: { id: `${run}-foreign`, organizationId: `${run}-other-org`, channelId: `${run}-foreign-channel`, contactId: `${run}-foreign-contact` } });
    const pins = [...ids.slice(0, 18), `${run}-denied`, `${run}-foreign`].map(id => ({ id, pinnedAt: '2026-01-01T00:00:00.000Z' }));
    await db.userOrganization.update({ where: { id: `${run}-membership` }, data: { preferences: { pinnedConversations: pins } } });
    await service.setPinned(`${run}-user`, `${run}-org`, ids[20], true, new Set([`${run}-channel`]));
    const result = (await prefs()).pinnedConversations.map((p: any) => p.id);
    expect(result).toHaveLength(19);
    expect(result).not.toContain(`${run}-denied`);
    expect(result).not.toContain(`${run}-foreign`);
    expect(result).toContain(ids[20]);
  });

});
