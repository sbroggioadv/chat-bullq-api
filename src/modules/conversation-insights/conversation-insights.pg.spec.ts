import { PrismaClient } from '@prisma/client';
import { ConversationInsightsService } from './conversation-insights.service';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';

// Explicit disposable local cluster only; never inherit DATABASE_URL.
const url = process.env.SPEC023_TEST_PG_URL;
const pgSuite = url ? describe : describe.skip;
pgSuite('Summary JSONB reservation on disposable PostgreSQL', () => {
  let pg: PrismaClient;
  beforeAll(async () => {
    if (!url?.startsWith('postgresql://spec023@127.0.0.1:55439/spec023_test')) throw new Error('Use the dedicated SPEC023 disposable database');
    pg = new PrismaClient({ datasources: { db: { url } } });
    await pg.$executeRaw`CREATE TABLE IF NOT EXISTS conversations (id text PRIMARY KEY, organization_id text NOT NULL, deleted_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}')`;
  });
  beforeEach(async () => {
    await pg.$executeRaw`DELETE FROM conversations`;
    await pg.$executeRaw`INSERT INTO conversations (id, organization_id, metadata) VALUES ('c1', 'org', '{"existing":"preserved"}')`;
  });
  afterAll(async () => { if (pg) await pg.$disconnect(); });
  function setup() {
    const llm = { completeWithProvider: jest.fn().mockImplementation(async () => {
      await pg.$executeRaw`UPDATE conversations SET metadata = jsonb_set(metadata, '{concurrent}', '"also preserved"') WHERE id = 'c1'`;
      return { stopReason: 'stop', message: { content: JSON.stringify({ assunto: 'Teste', situacao: 'Aberta', pendencias: 'Nenhuma', proximoPasso: 'Retornar' }) } };
    }) };
    const db = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', channelId: 'ch', metadata: {} }) },
      message: { findMany: jest.fn().mockResolvedValue([{ id: 'm1', direction: 'INBOUND', content: { text: 'Olá' } }]), count: jest.fn().mockResolvedValue(0) },
      $executeRaw: pg.$executeRaw.bind(pg),
    };
    return { llm, service: new ConversationInsightsService(db as never, new ChannelAccessService(db as never), {} as never, llm as never, { resolveForLlm: async () => ({ provider: 'OPENAI' }) } as never) };
  }
  it('permits exactly one of simultaneous clicks and preserves concurrent metadata', async () => {
    const { service, llm } = setup();
    const results = await Promise.allSettled([service.generateSummary('c1', 'org', 'ALL', { force: true }), service.generateSummary('c1', 'org', 'ALL', { force: true })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 429 } });
    expect(llm.completeWithProvider).toHaveBeenCalledTimes(1);
    const rows = await pg.$queryRaw<Array<{ metadata: Record<string, unknown> }>>`SELECT metadata FROM conversations WHERE id = 'c1'`;
    expect(rows[0].metadata).toMatchObject({ existing: 'preserved', concurrent: 'also preserved', summary: { messageCount: 1 } });
    await expect(service.generateSummary('c1', 'org', 'ALL', { force: true })).rejects.toMatchObject({ status: 429 });
  });
  it('keeps the limit after provider failure and allows retry after a minute', async () => {
    const { service, llm } = setup(); llm.completeWithProvider.mockRejectedValueOnce(new Error('offline'));
    await expect(service.generateSummary('c1', 'org', 'ALL', {})).rejects.toMatchObject({ status: 502 });
    await expect(service.generateSummary('c1', 'org', 'ALL', {})).rejects.toMatchObject({ status: 429 });
    await pg.$executeRaw`UPDATE conversations SET metadata = jsonb_set(metadata, '{summaryRequestedAt}', to_jsonb(${new Date(Date.now() - 61000).toISOString()}::text)) WHERE id = 'c1'`;
    await expect(service.generateSummary('c1', 'org', 'ALL', {})).resolves.toMatchObject({ messageCount: 1 });
  });
});
