import { PrismaClient } from '@prisma/client';
import { ConversationInsightsService } from './conversation-insights.service';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';

const url = process.env.SPEC024_TEST_PG_URL;
const pgSuite = url ? describe : describe.skip;
pgSuite('Attachment filters on disposable PostgreSQL', () => {
  let pg: PrismaClient;
  let service: ConversationInsightsService;
  let org: string;
  let conversation: string;
  const ids: string[] = [];
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.protocol !== 'postgresql:' || parsed.hostname !== 'localhost' || parsed.port !== '5432' || parsed.pathname !== '/spec024_s08' || parsed.password) throw new Error('Use the dedicated local disposable database');
    pg = new PrismaClient({ datasources: { db: { url } } });
    org = (await pg.organization.create({ data: { name: 'Attachment fixture', slug: `attachments-${Date.now()}` } })).id;
    const channel = await pg.channel.create({ data: { organizationId: org, type: 'WHATSAPP_OFFICIAL', name: 'Fixture', config: {} } });
    const contact = await pg.contact.create({ data: { organizationId: org } });
    conversation = (await pg.conversation.create({ data: { organizationId: org, channelId: channel.id, contactId: contact.id } })).id;
    const fixtures = [
      { fileName: 'ConTrAtO.pdf', direction: 'INBOUND', type: 'DOCUMENT' },
      { fileName: 'CONTRATO-final.pdf', direction: 'OUTBOUND', type: 'DOCUMENT' },
      { fileName: 'contrato.png', direction: 'INBOUND', type: 'IMAGE' },
      { fileName: 'invoice.pdf', direction: 'OUTBOUND', type: 'DOCUMENT' },
      { fileName: null, direction: 'INBOUND', type: 'IMAGE' },
      { fileName: '50%_back\\slash.pdf', direction: 'OUTBOUND', type: 'DOCUMENT' },
    ] as const;
    for (const [index, fixture] of fixtures.entries()) {
      ids.push((await pg.message.create({ data: { conversationId: conversation, direction: fixture.direction, type: fixture.type, content: { fileName: fixture.fileName }, createdAt: new Date(1700000000000 + index * 1000) } })).id);
    }
    service = new ConversationInsightsService(pg as never, new ChannelAccessService(pg as never), {} as never, {} as never, {} as never);
  });
  afterAll(async () => {
    if (org) await pg.organization.delete({ where: { id: org } });
    if (pg) await pg.$disconnect();
  });
  const list = (query: { q?: string; origin?: string; kind?: string; limit?: string; before?: string }) => service.attachments(conversation, org, 'ALL', query);
  it('matches only the filename, case-insensitively', async () => {
    const result = await list({ q: 'contrato' });
    expect(result.items.map(item => item.messageId)).toEqual([ids[2], ids[1], ids[0]]);
  });
  it.each(['%', '_', '\\'])('matches %s literally in the filename', async q => {
    const result = await list({ q });
    expect(result.items.map(item => item.messageId)).toEqual([ids[5]]);
  });
  it.each(['received', 'sent'] as const)('filters %s by message direction', async origin => {
    const result = await list({ origin });
    expect(result.items.map(item => item.messageId)).toEqual(origin === 'received' ? [ids[4], ids[2], ids[0]] : [ids[5], ids[3], ids[1]]);
  });
  it('combines all filters before applying the page limit and cursor', async () => {
    const query = { q: 'contrato', origin: 'received', kind: 'document', limit: '1' };
    const result = await list(query);
    expect(result.items.map(item => item.messageId)).toEqual([ids[0]]);
    expect(result.nextCursor).toBeNull();
    const first = await list({ q: 'contrato', limit: '1' });
    expect(first.items[0].messageId).toBe(ids[2]);
    const next = await list({ q: 'contrato', limit: '1', before: first.nextCursor! });
    expect(next.items[0].messageId).toBe(ids[1]);
  });
  it('keeps the unfiltered list, metadata and media route unchanged', async () => {
    const result = await list({});
    expect(result.items.map(item => item.messageId)).toEqual([...ids].reverse());
    expect(result.items[5]).toMatchObject({ fileName: 'ConTrAtO.pdf', mediaPath: `/messages/${ids[0]}/media`, direction: 'INBOUND' });
    expect(result.nextCursor).toBeNull();
  });
});
