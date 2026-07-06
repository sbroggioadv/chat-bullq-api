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
