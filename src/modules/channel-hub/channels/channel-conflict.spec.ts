import { ChannelType } from '@prisma/client';
import { ChannelsService } from './channels.service';

describe('conexão repetida entre espaços', () => {
  const pairs: Array<[ChannelType, any]> = [
    [ChannelType.WHATSAPP_ZAPPFY, { instanceId: 'instance-1', token: 'synthetic' }],
    [ChannelType.WHATSAPP_OFFICIAL, { phoneNumberId: 'phone-1' }],
    [ChannelType.INSTAGRAM, { igBusinessId: 'ig-1' }],
  ];
  function setup(type: ChannelType, config: any, otherOrg = 'B') {
    const existing = { id: 'other', organizationId: otherOrg, type, config, isActive: true };
    const own = { id: 'own', organizationId: 'A', type, config, isActive: false };
    const repository = { findActiveByType: jest.fn(async () => [existing]), findById: jest.fn(async () => own), create: jest.fn(async (data) => ({ id: 'new', ...data })), update: jest.fn(async (_id, data) => ({ ...own, ...data })) };
    const registry = { hasHistorySync: () => false };
    const service = new ChannelsService(repository as any, registry as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { channelAgent: { create: jest.fn() } } as any, {} as any);
    return { service, repository };
  }
  it.each(pairs)('recusa criar canal %s já ativo em outra organização', async (type, config) => {
    const { service, repository } = setup(type, config);
    await expect(service.create('A', { type, name: 'canal', config })).rejects.toMatchObject({ status: 409, message: 'Este número já está conectado em outro espaço. Desconecte lá antes de conectar aqui.' });
    expect(repository.create).not.toHaveBeenCalled();
  });
  it.each(pairs)('recusa reativar canal %s já ativo em outra organização', async (type, config) => {
    const { service, repository } = setup(type, config);
    await expect(service.update('own', 'A', { isActive: true })).rejects.toMatchObject({ status: 409 });
    expect(repository.update).not.toHaveBeenCalled();
  });
  it('permite reativar quando não há colisão entre organizações', async () => {
    const { service, repository } = setup(ChannelType.WHATSAPP_OFFICIAL, { phoneNumberId: 'phone-1' }, 'A');
    await service.update('own', 'A', { isActive: true });
    expect(repository.update).toHaveBeenCalled();
  });
});
