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

describe('canal no início do OAuth', () => {
  const findFirst = jest.fn(async ({ where }: any) => where.id === 'proprio' && where.organizationId === 'B' ? { id: 'proprio' } : null);
  const service = new GmailOAuthService({ get: () => 'sintetico' } as any, {} as any, { channel: { findFirst } } as any);
  const input = { organizationId: 'B', userOrganizationId: 'usuario', role: OrgRole.ADMIN };
  beforeEach(() => findFirst.mockClear());
  it.each(['alheio', 'inexistente'])('recusa %s com 404', async (channelId) => {
    await expect(service.start({ ...input, channelId })).rejects.toMatchObject({ status: 404 });
  });
  it('aceita canal próprio e mantém o id no state', async () => {
    const result = await service.start({ ...input, channelId: 'proprio' });
    const state = new URL(result.url).searchParams.get('state')!;
    expect(JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString()).channelId).toBe('proprio');
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'proprio', organizationId: 'B', deletedAt: null }, select: { id: true } });
  });
  it('recusa state com organização alterada e aceita a assinatura original', async () => {
    const result = await service.start(input);
    const state = new URL(result.url).searchParams.get('state')!;
    const [body, signature] = state.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    expect((service as any).verifyState(state).orgId).toBe('B');
    payload.orgId = 'A';
    const changed = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
    expect((service as any).verifyState.bind(service, changed)).toThrow('state signature mismatch');
    expect(await service.handleCallback('code', changed)).toContain('gmail=error&reason=invalid_state');
  });
});
