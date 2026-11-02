import { ContactAvatarCronService } from './contact-avatar-cron.service';

describe('ContactAvatarCronService', () => {
  let prisma: any, enricher: any, service: ContactAvatarCronService;
  const row = (id: string) => ({ id, contactId: id, externalId: id, channel: {} });
  beforeEach(() => {
    process.env.CONTACT_AVATAR_CRON_BATCH = '2';
    process.env.CONTACT_AVATAR_CRON_PAUSE_MS = '0';
    prisma = { contactChannel: { findMany: jest.fn() }, contact: { findUnique: jest.fn().mockResolvedValue(null) } };
    enricher = { enrich: jest.fn().mockResolvedValue({ enriched: false }) };
    service = new ContactAvatarCronService(prisma, enricher, { rehostAvatarToBullq: jest.fn() } as any);
  });
  afterEach(() => { delete process.env.CONTACT_AVATAR_CRON_BATCH; delete process.env.CONTACT_AVATAR_CRON_PAUSE_MS; });
  it('limits and orders only contacts without photos, advances and wraps', async () => {
    prisma.contactChannel.findMany.mockResolvedValueOnce([row('a'), row('b')]).mockResolvedValueOnce([row('c')]).mockResolvedValueOnce([row('a')]);
    await service.scanAndEnrich(); await service.scanAndEnrich(); await service.scanAndEnrich();
    expect(prisma.contactChannel.findMany.mock.calls[0][0]).toMatchObject({ where: { contact: { deletedAt: null, avatarUrl: null } }, take: 2, orderBy: { id: 'asc' } });
    expect(prisma.contactChannel.findMany.mock.calls[1][0]).toMatchObject({ where: { id: { gt: 'b' } } });
    expect(prisma.contactChannel.findMany.mock.calls[2][0].where.id).toBeUndefined();
  });
  it('stops on 429 and retries that row next tick', async () => {
    prisma.contactChannel.findMany.mockResolvedValueOnce([row('a'), row('b')]).mockResolvedValueOnce([row('b')]);
    enricher.enrich.mockResolvedValueOnce({ enriched: false }).mockResolvedValueOnce({ enriched: false, reason: 'rate_limited' }).mockResolvedValueOnce({ enriched: true });
    await service.scanAndEnrich(); await service.scanAndEnrich();
    expect(prisma.contactChannel.findMany.mock.calls[1][0]).toMatchObject({ where: { id: { gt: 'a' } } });
    expect(enricher.enrich).toHaveBeenCalledTimes(3);
  });
});
