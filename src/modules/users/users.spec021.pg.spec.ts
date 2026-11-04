import { PrismaClient } from '@prisma/client';
import { UsersService } from './users.service';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';

const url = process.env.SPEC021_PG_URL;
const suite = url ? describe : describe.skip;

suite('SPEC-021: concorrência no PostgreSQL descartável', () => {
  let db: PrismaClient;
  let service: UsersService;
  const ids = Array.from({ length: 22 }, (_, i) => `synthetic-c${i}`);
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/spec021') throw new Error('Use apenas banco local descartável spec021');
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.organization.create({ data: { id: 'synthetic-org', name: 'Synthetic', slug: 'synthetic-org' } });
    await db.user.create({ data: { id: 'synthetic-user', name: 'Synthetic', email: 'synthetic@example.test', password: 'synthetic' } });
    await db.userOrganization.create({ data: { id: 'synthetic-membership', userId: 'synthetic-user', organizationId: 'synthetic-org' } });
    await db.channel.create({ data: { id: 'synthetic-channel', organizationId: 'synthetic-org', name: 'Synthetic', type: 'WHATSAPP_ZAPPFY', config: {} } });
    await db.contact.create({ data: { id: 'synthetic-contact', organizationId: 'synthetic-org' } });
    for (const id of ids) await db.conversation.create({ data: { id, organizationId: 'synthetic-org', channelId: 'synthetic-channel', contactId: 'synthetic-contact' } });
    service = new UsersService(db as any, new ChannelAccessService(db as any));
  });
  beforeEach(async () => {
    await db.userOrganization.update({ where: { id: 'synthetic-membership' }, data: { preferences: {} } });
  });
  afterAll(async () => { await db?.$disconnect(); });
  const pin = (id: string) => service.setPinned('synthetic-user', 'synthetic-org', id, true, 'ALL');
  const prefs = () => service.getPreferences('synthetic-user', 'synthetic-org') as Promise<any>;
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
    await Promise.all([pin(ids[1]), service.updatePreferences('synthetic-user', 'synthetic-org', { inbox: { scope: 'MINE' }, pinnedConversations: [] })]);
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
    await db.organization.create({ data: { id: 'synthetic-other-org', name: 'Synthetic', slug: 'synthetic-other-org' } });
    await db.channel.create({ data: { id: 'synthetic-other-channel', organizationId: 'synthetic-org', name: 'Synthetic', type: 'WHATSAPP_ZAPPFY', config: {} } });
    await db.channel.create({ data: { id: 'synthetic-foreign-channel', organizationId: 'synthetic-other-org', name: 'Synthetic', type: 'WHATSAPP_ZAPPFY', config: {} } });
    await db.contact.create({ data: { id: 'synthetic-foreign-contact', organizationId: 'synthetic-other-org' } });
    await db.conversation.create({ data: { id: 'synthetic-denied', organizationId: 'synthetic-org', channelId: 'synthetic-other-channel', contactId: 'synthetic-contact' } });
    await db.conversation.create({ data: { id: 'synthetic-foreign', organizationId: 'synthetic-other-org', channelId: 'synthetic-foreign-channel', contactId: 'synthetic-foreign-contact' } });
    const pins = [...ids.slice(0, 18), 'synthetic-denied', 'synthetic-foreign'].map(id => ({ id, pinnedAt: '2026-01-01T00:00:00.000Z' }));
    await db.userOrganization.update({ where: { id: 'synthetic-membership' }, data: { preferences: { pinnedConversations: pins } } });
    await service.setPinned('synthetic-user', 'synthetic-org', ids[20], true, new Set(['synthetic-channel']));
    const result = (await prefs()).pinnedConversations.map((p: any) => p.id);
    expect(result).toHaveLength(19);
    expect(result).not.toContain('synthetic-denied');
    expect(result).not.toContain('synthetic-foreign');
    expect(result).toContain(ids[20]);
  });

});
