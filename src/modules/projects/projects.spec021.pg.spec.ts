import { Prisma, PrismaClient } from '@prisma/client';
import { ProjectsService } from './projects.service';

const url = process.env.SPEC021_PG_URL;
const suite = url ? describe : describe.skip;

suite('SPEC-021: plano de JIDs no PostgreSQL descartável', () => {
  let db: PrismaClient;
  const run = `r3-${process.pid}-${Date.now()}`;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/spec021') throw new Error('Use apenas banco local descartável spec021');
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$executeRaw`INSERT INTO organizations (id, name, slug, updated_at) VALUES (${run}, 'Synthetic', ${run}, now()), (${run + '-other'}, 'Synthetic', ${run + '-other'}, now())`;
    await db.$executeRaw`INSERT INTO channels (id, organization_id, type, name, config, updated_at, deleted_at) VALUES (${run + '-ch'}, ${run}, 'WHATSAPP_ZAPPFY', 'Synthetic', '{}', now(), now()), (${run + '-foreign'}, ${run + '-other'}, 'WHATSAPP_ZAPPFY', 'Synthetic', '{}', now(), null)`;
    await db.$executeRaw`INSERT INTO contacts (id, organization_id, updated_at) SELECT ${run} || '-own-' || i, ${run}, now() FROM generate_series(1,20) i`;
    await db.$executeRaw`INSERT INTO contacts (id, organization_id, updated_at) SELECT ${run} || '-foreign-' || i, ${run + '-other'}, now() FROM generate_series(1,10000) i`;
    await db.$executeRaw`INSERT INTO contact_channels (id, contact_id, channel_id, external_id) SELECT ${run} || '-cc-own-' || i, ${run} || '-own-' || i, ${run + '-ch'}, ${run} || '-jid-' || i || '@g.us' FROM generate_series(1,20) i`;
    await db.$executeRaw`INSERT INTO contact_channels (id, contact_id, channel_id, external_id) SELECT ${run} || '-cc-foreign-' || i, ${run} || '-foreign-' || i, ${run + '-foreign'}, ${run} || '-jid-' || i || '@g.us' FROM generate_series(1,10000) i`;
    await db.$executeRaw`INSERT INTO conversations (id, organization_id, channel_id, contact_id, is_group, updated_at) SELECT ${run} || '-conv-' || i, ${run}, ${run + '-ch'}, ${run} || '-own-' || i, true, now() FROM generate_series(1,20) i`;
    await db.$executeRawUnsafe('ANALYZE');
  }, 30000);
  afterAll(async () => { await db?.$disconnect(); });
  it('mantém o resultado e não faz Seq Scan em contact_channels', async () => {
    let captured: Prisma.Sql | undefined;
    const prisma: any = {
      projectConversation: { findMany: jest.fn().mockResolvedValue([]) },
      project: { findMany: jest.fn().mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ groupJid: `${run}-jid-${i + 1}@g.us` }))) },
      $queryRaw: (strings: TemplateStringsArray, ...values: any[]) => { captured = Prisma.sql(strings, ...values); return db.$queryRaw(captured); },
    };
    const service = new ProjectsService(prisma, {} as any);
    jest.spyOn(service, 'toDetail').mockReturnValue({ kind: 'PROJECT' } as any);
    const result = await service.resolveFilter(run, { kind: 'ANY' });
    expect(result.representativeIds).toHaveLength(20);
    expect(result.memberChannelIds).toEqual([`${run}-ch`]);
    const plan: any = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${captured!.text}`, ...captured!.values);
    const scans: any[] = [];
    const visit = (node: any) => { if (node['Relation Name'] === 'contact_channels') scans.push(node['Node Type']); (node.Plans || []).forEach(visit); };
    visit(plan[0]['QUERY PLAN'][0].Plan);
    expect(scans.length).toBeGreaterThan(0);
    expect(scans).not.toContain('Seq Scan');
  }, 30000);
});
