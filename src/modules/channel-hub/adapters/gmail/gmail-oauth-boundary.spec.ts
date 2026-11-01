import { ChannelType, OrgRole } from '@prisma/client';
import { GmailOAuthService } from './gmail-oauth.service';

describe('fronteira OAuth Gmail', () => {
  const email = 'conta@example.test';
  function setup(channels: any[]) {
    const prisma = { channel: {
      findMany: jest.fn(async ({ where }: any) => channels.filter((c) =>
        c.type === where.type && c.deletedAt === null &&
        (typeof where.organizationId === 'string' ? c.organizationId === where.organizationId :
          where.organizationId?.not ? c.organizationId !== where.organizationId.not : true) &&
        (where.isActive === undefined || c.isActive === where.isActive) &&
        (!where.id?.not || c.id !== where.id.not))),
      update: jest.fn(async () => ({})),
    } };
    const channelService = { create: jest.fn(async () => ({ id: 'new' })), ensureInboxViewForChannel: jest.fn(), cleanupGmailInboxViewsForRetiredChannels: jest.fn() };
    const service = new GmailOAuthService({ get: () => 'synthetic' } as any, channelService as any, prisma as any);
    jest.spyOn(service as any, 'verifyState').mockReturnValue({ orgId: 'B', uoId: 'user', role: OrgRole.ADMIN, visibility: 'PRIVATE' });
    jest.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'synthetic', refresh_token: 'synthetic' });
    jest.spyOn(service as any, 'fetchEmail').mockResolvedValue(email);
    return { service, prisma, channelService };
  }
  const channel = (org: string, deletedAt: Date | null = null) => ({ id: org, organizationId: org, type: ChannelType.GMAIL, deletedAt, isActive: true, config: { email, refreshToken: 'synthetic' } });
  it('recusa conta ativa em outro espaço sem criar ou alterar canal', async () => {
    const { service, prisma, channelService } = setup([channel('A')]);
    expect(await service.handleCallback('code', 'state')).toContain('gmail=error&reason=account_unavailable');
    expect(channelService.create).not.toHaveBeenCalled();
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });
  it('reconecta no próprio espaço', async () => {
    const { service, prisma } = setup([channel('B')]);
    expect(await service.handleCallback('code', 'state')).toContain('gmail=connected&updated=1');
    expect(prisma.channel.update).toHaveBeenCalledTimes(1);
  });
  it('permite conta removida em outro espaço', async () => {
    const { service, channelService } = setup([channel('A', new Date())]);
    expect(await service.handleCallback('code', 'state')).toContain('gmail=connected');
    expect(channelService.create).toHaveBeenCalledTimes(1);
  });
  it.each([{ channels: [] }, { channels: [channel('B')] }])('recusa email vazio sem gravar token', async ({ channels }) => {
    const { service, prisma, channelService } = setup(channels);
    jest.spyOn(service as any, 'fetchEmail').mockResolvedValue('');
    expect(await service.handleCallback('code', 'state')).toContain('gmail=error');
    expect(channelService.create).not.toHaveBeenCalled();
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

});
