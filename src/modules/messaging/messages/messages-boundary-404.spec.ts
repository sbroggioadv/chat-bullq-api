import { NotFoundException } from '@nestjs/common';
import { MessagesService } from './messages.service';

describe('fronteira de mensagens', () => {
  const conv = { id: 'conv-A', organizationId: 'A', channelId: 'channel-A' };
  const prisma = { conversation: { findUnique: jest.fn(async () => conv) }, message: { findUnique: jest.fn(async () => ({ id: 'msg-A', conversation: conv, revokedAt: new Date(0), direction: 'OUTBOUND' })) } };
  const repository = { findByConversation: jest.fn() };
  const service = new MessagesService(repository as any, prisma as any, {} as any, { assertChannelAccess: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  it('oculta conversa alheia no envio', async () => {
    await expect(service.send({ conversationId: 'conv-A' } as any, 'user', 'B')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('oculta conversa alheia na listagem', async () => {
    await expect(service.findByConversation('conv-A', 'B', 1, 20)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('oculta mensagem alheia na revogação e mantém a própria', async () => {
    await expect(service.revokeForEveryone('msg-A', 'B', 'user')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.revokeForEveryone('msg-A', 'A', 'user')).resolves.toMatchObject({ messageId: 'msg-A' });
  });
});

describe('emissor de leitura ao enviar', () => {
  it('publica somente na sala pessoal da organização ativa', async () => {
    const conv = { id: 'conv-A', organizationId: 'A', channelId: 'channel-A', assignedToId: 'user', aiEnabled: false, channel: { type: 'WHATSAPP_ZAPPFY' }, contact: { channels: [{ channelId: 'channel-A', externalId: 'contact' }] } };
    const prisma = { conversation: { findUnique: jest.fn(async () => conv), update: jest.fn() }, organization: { findUnique: jest.fn(async () => ({})) }, conversationRead: { upsert: jest.fn() } };
    const gateway = { emitToUserInOrg: jest.fn(), emitToUser: jest.fn(), emitToChannel: jest.fn(), emitToConversation: jest.fn() };
    const service = new MessagesService({ create: jest.fn(async () => ({ id: 'message-A' })) } as any, prisma as any, gateway as any, { assertChannelAccess: jest.fn() } as any, { cancelCheck: jest.fn(async () => undefined) } as any, {} as any, {} as any, {} as any, {} as any, { add: jest.fn() } as any);
    await service.send({ conversationId: 'conv-A', type: 'TEXT', content: { text: 'teste' } } as any, 'user', 'A');
    expect(gateway.emitToUserInOrg).toHaveBeenCalledWith('user', 'A', 'conversation:read', expect.any(Object));
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });
});
