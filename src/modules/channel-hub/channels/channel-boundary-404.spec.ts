import { NotFoundException } from '@nestjs/common';
import { ChannelsService } from './channels.service';

describe('fronteira de canal', () => {
  it('oculta canal alheio e mantém o acesso ao canal próprio', async () => {
    const channel = { id: 'channel-A', organizationId: 'A' };
    const repository = { findById: jest.fn(async () => channel) };
    const service = new ChannelsService(repository as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(service.findOne('channel-A', 'B')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findOne('channel-A', 'A')).resolves.toEqual(channel);
  });
});
