import { ChannelType, OrgRole } from '@prisma/client';
import { ChannelsService } from './channels.service';

function buildService() {
  const repository = {
    create: jest.fn(async (data) => ({ id: 'ch1', ...data })),
    findById: jest.fn(async () => ({
      id: 'ch1',
      type: ChannelType.INSTAGRAM,
      config: { igBusinessId: 'ig-1' },
    })),
    update: jest.fn(),
    findActiveByType: jest.fn(async () => []),
  };
  const prisma = {
    channelAgent: {
      create: jest.fn(async () => ({ id: 'grant1' })),
    },
  };
  const adapterRegistry = { hasHistorySync: jest.fn(() => false) };

  const service = new ChannelsService(
    repository as any,
    adapterRegistry as any,
    {} as any,
    {} as any,
    { getMe: jest.fn() } as any,
    {} as any,
    {} as any,
    { getProfile: jest.fn() } as any, // gmailHttpClient
    { start: jest.fn() } as any,
    prisma as any,
    {} as any,
  );

  return { service, repository, prisma };
}

describe('ChannelsService.create', () => {
  it('defaults new channels to PRIVATE and grants creator access', async () => {
    const { service, repository, prisma } = buildService();

    await service.create(
      'org1',
      {
        type: ChannelType.INSTAGRAM,
        name: 'WhatsApp Marcela',
        config: { igBusinessId: 'ig-1' },
      },
      { userOrganizationId: 'uo1', role: OrgRole.ADMIN },
    );

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'PRIVATE' }),
    );
    expect(prisma.channelAgent.create).toHaveBeenCalledWith({
      data: { channelId: 'ch1', userOrganizationId: 'uo1' },
    });
  });

  it('does not grant owner/admin when caller explicitly creates an ORG channel', async () => {
    const { service, repository, prisma } = buildService();

    await service.create(
      'org1',
      {
        type: ChannelType.INSTAGRAM,
        name: 'Canal compartilhado',
        config: { igBusinessId: 'ig-1' },
        visibility: 'ORG',
      },
      { userOrganizationId: 'uo1', role: OrgRole.ADMIN },
    );

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'ORG' }),
    );
    expect(prisma.channelAgent.create).not.toHaveBeenCalled();
  });
});


describe('ChannelsService.update — partial credentials', () => {
  const saved = { id: 'ch1', organizationId: 'org1', type: ChannelType.GMAIL,
    config: { token: 'fake-token', appSecret: 'fake-app', query: 'old', nested: { keep: 'yes', change: 'old' } },
    webhookSecret: 'fake-webhook' };
  function setup() {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(saved as any);
    repository.update.mockImplementation(async (_id, data) => ({ ...saved, ...data }));
    return { service, repository };
  }
  it('PATCH only name preserves config and webhook secret', async () => {
    const { service } = setup();
    const result = await service.update('ch1', 'org1', { name: 'Renamed' });
    expect(result!.config).toEqual(saved.config);
    expect(result!.webhookSecret).toBe(saved.webhookSecret);
  });
  it('merges a partial config, including nested objects', async () => {
    const { service } = setup();
    const result = await service.update('ch1', 'org1', { config: { query: 'new', nested: { change: 'new' } } });
    expect(result!.config).toEqual({ ...saved.config, query: 'new', nested: { keep: 'yes', change: 'new' } });
    expect(result!.webhookSecret).toBe(saved.webhookSecret);
  });
  it('null removes an optional field, omitted credentials remain', async () => {
    const { service } = setup();
    const result = await service.update('ch1', 'org1', { config: { query: null } });
    const { query, ...expected } = saved.config;
    expect(result!.config).toEqual(expected);
  });
  it('rejects null config instead of erasing credentials', async () => {
    const { service } = setup();
    await expect(service.update('ch1', 'org1', { config: null } as any)).rejects.toThrow();
  });
  it('changes webhook secret only when explicitly supplied', async () => {
    const { service } = setup();
    const result = await service.update('ch1', 'org1', { webhookSecret: 'fake-replacement' });
    expect(result!.webhookSecret).toBe('fake-replacement');
  });
  it('explicit null clears webhook secret', async () => {
    const { service } = setup();
    const result = await service.update('ch1', 'org1', { webhookSecret: null });
    expect(result!.webhookSecret).toBeNull();
    expect(result!.config).toEqual(saved.config);
  });
  it('keeps tenant authorization before updating', async () => {
    const { service, repository } = setup();
    await expect(service.update('ch1', 'other', { config: {} })).rejects.toThrow();
    expect(repository.update).not.toHaveBeenCalled();
  });
});
