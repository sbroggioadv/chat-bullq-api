import { OrgRole } from '@prisma/client';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

describe('ChannelsController — browser serialization', () => {
  const channel = {
    id: 'channel', organizationId: 'org', type: 'GMAIL', name: 'Mail',
    isActive: true, visibility: 'PRIVATE', aiEnabled: null,
    createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    config: { accessToken: 'fake-sensitive-value' },
    webhookSecret: 'fake-webhook-secret', futureSecret: 'fake-future-secret',
  };
  const service = {
    create: jest.fn().mockResolvedValue(channel),
    findAll: jest.fn().mockResolvedValue([channel]),
    findOne: jest.fn().mockResolvedValue(channel),
    update: jest.fn().mockResolvedValue(channel),
    remove: jest.fn().mockResolvedValue(channel),
  };
  const controller = new ChannelsController(service as unknown as ChannelsService);
  const org = { id: 'org', userOrganizationId: 'uo', userRole: OrgRole.ADMIN };

  it.each(['create', 'list', 'detail', 'update', 'delete'])('%s excludes credentials and preserves browser state', async (route) => {
    let result: any;
    switch (route) {
      case 'create': result = await controller.create(org, {} as any); break;
      case 'list': result = (await controller.findAll('org', 'ALL'))[0]; break;
      case 'detail': result = await controller.findOne('channel', 'org', 'ALL'); break;
      case 'update': result = await controller.update('channel', 'org', 'uo', {}); break;
      case 'delete': result = await controller.remove('channel', 'org', 'Mail'); break;
    }
    expect(result).toEqual({
      id: 'channel', organizationId: 'org', type: 'GMAIL', name: 'Mail',
      isActive: true, visibility: 'PRIVATE', aiEnabled: null,
      createdAt: channel.createdAt, updatedAt: channel.updatedAt, deletedAt: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/config|Secret|sensitive|secret/);
    // The same object stays available internally for provider calls.
    expect(channel.config.accessToken).toBe('fake-sensitive-value');
  });

  it('preserves authorization errors from the service', async () => {
    service.findOne.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(controller.findOne('channel', 'other-org', 'ALL')).rejects.toThrow('Forbidden');
  });
});
