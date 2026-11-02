import { ContactAvatarCronService } from './contact-avatar-cron.service';

describe('ContactAvatarCronService', () => {
  let prisma: any, enricher: any, service: ContactAvatarCronService;
  const row = (id: string) => ({ id, contactId: id, externalId: id, channel: {} });
  beforeEach(() => {
    process.env.CONTACT_AVATAR_CRON_BATCH = '2';
    process.env.CONTACT_AVATAR_CRON_PAUSE_MS = '0';
    prisma = { contactChannel: { findMany: jest.fn().mockResolvedValue([]) }, contact: { findUnique: jest.fn().mockResolvedValue(null) } };
    enricher = { enrich: jest.fn().mockResolvedValue({ enriched: false }) };
    service = new ContactAvatarCronService(prisma, enricher, { rehostAvatarToBullq: jest.fn() } as any);
  });
  afterEach(() => { delete process.env.CONTACT_AVATAR_CRON_BATCH; delete process.env.CONTACT_AVATAR_CRON_PAUSE_MS; delete process.env.CONTACT_AVATAR_CRON_CDN_SHARE; });
  it('limits and orders only contacts without photos, advances and wraps', async () => {
    prisma.contactChannel.findMany.mockResolvedValueOnce([row('a'), row('b')]).mockResolvedValueOnce([]).mockResolvedValueOnce([row('c')]).mockResolvedValueOnce([]).mockResolvedValueOnce([row('a')]).mockResolvedValueOnce([]);
    await service.scanAndEnrich(); await service.scanAndEnrich(); await service.scanAndEnrich();
    expect(prisma.contactChannel.findMany.mock.calls[0][0]).toMatchObject({ where: { contact: { deletedAt: null, avatarUrl: null } }, take: 2, orderBy: { id: 'asc' } });
    expect(prisma.contactChannel.findMany.mock.calls[2][0]).toMatchObject({ where: { id: { gt: 'b' } } });
    expect(prisma.contactChannel.findMany.mock.calls[4][0].where.id).toBeUndefined();
  });
  it('stops on 429 and retries that row next tick', async () => {
    prisma.contactChannel.findMany.mockResolvedValueOnce([row('a'), row('b')]).mockResolvedValueOnce([]).mockResolvedValueOnce([row('b')]).mockResolvedValueOnce([]);
    enricher.enrich.mockResolvedValueOnce({ enriched: false }).mockResolvedValueOnce({ enriched: false, reason: 'rate_limited' }).mockResolvedValueOnce({ enriched: true });
    await service.scanAndEnrich(); await service.scanAndEnrich();
    expect(prisma.contactChannel.findMany.mock.calls[2][0]).toMatchObject({ where: { id: { gt: 'a' } } });
    expect(enricher.enrich).toHaveBeenCalledTimes(3);
  });
  it('prioritizes missing photos and fills remaining slots with non-rehosted photos', async () => {
    prisma.contactChannel.findMany.mockResolvedValueOnce([row('a')]).mockResolvedValueOnce([row('b')]);
    await service.scanAndEnrich();
    expect(enricher.enrich.mock.calls.map((call: any[]) => call[1])).toEqual(['a', 'b']);
    expect(prisma.contactChannel.findMany.mock.calls[1][0]).toMatchObject({ where: { contact: { deletedAt: null, avatarUrl: { not: null }, NOT: { avatarUrl: { contains: '/api/v1/uploads/' } } } }, take: 1 });
  });

  it.each([[100, '0.2', 80, 20], [10, '0', 9, 1], [10, '1', 0, 10]])('reserves CDN capacity on every cycle', async (batch, share, missing, external) => {
    process.env.CONTACT_AVATAR_CRON_BATCH = String(batch);
    process.env.CONTACT_AVATAR_CRON_CDN_SHARE = share;
    prisma.contactChannel.findMany.mockImplementation(async ({ where, take }: any) => {
      const isExternal = where.contact.avatarUrl !== null;
      return Array.from({ length: take }, (_, i) => row(`${isExternal ? 'e' : 'm'}${i}`));
    });
    await service.scanAndEnrich();
    await service.scanAndEnrich();
    for (const calls of [enricher.enrich.mock.calls.slice(0, batch), enricher.enrich.mock.calls.slice(batch)]) {
      expect(calls.filter((c: any[]) => c[1].startsWith('m'))).toHaveLength(missing);
      expect(calls.filter((c: any[]) => c[1].startsWith('e'))).toHaveLength(external);
    }
  });
  it.each([true, false])('fills the entire batch when one group has no candidates: missing=%s', async (missingOnly) => {
    process.env.CONTACT_AVATAR_CRON_BATCH = '10';
    prisma.contactChannel.findMany.mockImplementation(async ({ where, take }: any) => {
      const isMissing = where.contact.avatarUrl === null;
      return isMissing === missingOnly ? Array.from({ length: take }, (_, i) => row(`id${i}`)) : [];
    });
    expect((await service.scanAndEnrich()).scanned).toBe(10);
  });

});
