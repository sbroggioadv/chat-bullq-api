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
