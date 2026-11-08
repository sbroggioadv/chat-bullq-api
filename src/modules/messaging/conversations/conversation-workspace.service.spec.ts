import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConversationWorkspaceService } from './conversation-workspace.service';
import { ChannelAccessService } from '../../iam/channel-access/channel-access.service';

function fixture() {
  const conversation = { id: 'conv', organizationId: 'org', channelId: 'wa', contactId: 'person', isGroup: false, metadata: {}, contact: { phone: '+5511999999999', email: 'person@example.test' } };
  const prisma: any = {
    conversation: { findFirst: jest.fn().mockResolvedValue(conversation), findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'new' }), update: jest.fn().mockImplementation(async ({ data }: any) => ({ ...conversation, ...data })) },
    internalNote: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'note', content: 'nota', authorId: 'author', createdAt: new Date(), updatedAt: new Date() }), findFirst: jest.fn(), update: jest.fn(), delete: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'author', name: 'Autor' }]) },
    channel: { findMany: jest.fn().mockResolvedValue([{ id: 'wa', name: 'WhatsApp', type: 'WHATSAPP_ZAPPFY', isActive: true }, { id: 'mail', name: 'E-mail', type: 'GMAIL', isActive: true }]) },
    contactChannel: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    conversationAuditLog: { create: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const realtime: any = { emitToChannel: jest.fn(), emitToConversation: jest.fn() };
  const locks: any = { withLock: jest.fn(async (_: string, fn: () => unknown) => fn()) };
  const service = new ConversationWorkspaceService(prisma, new ChannelAccessService(prisma), realtime, locks);
  return { service, prisma, realtime, conversation, locks };
}

describe('SPEC-023 API-1', () => {
  it.each(['1h', '8h', '24h', 'forever', 'off'])('F1 aplica %s, audita e transmite sem mudar IA ou leitura', async mode => {
    const { service, prisma, realtime } = fixture();
    const before = Date.now();
    const result = await service.mute('conv', 'org', 'author', 'ALL', mode);
    const hours = { '1h': 1, '8h': 8, '24h': 24 }[mode];
    if (hours) expect(new Date(result.mutedUntil!).getTime()).toBeGreaterThanOrEqual(before + hours * 3600000);
    else expect(result.mutedUntil).toBe(mode === 'off' ? null : '9999-12-31T23:59:59.000Z');
    expect(Object.keys(prisma.conversation.update.mock.calls[0][0].data)).toEqual(['mutedUntil']);
    expect(realtime.emitToChannel).toHaveBeenCalledWith('wa', 'conversation:updated', expect.objectContaining({ conversation: expect.objectContaining({ mutedUntil: result.mutedUntil ? expect.any(Date) : null }) }));
  });
  it('F1 rejeita modo inválido e propaga falha de persistência', async () => {
    const { service, prisma } = fixture();
    await expect(service.mute('conv', 'org', 'author', 'ALL', 'bad')).rejects.toBeInstanceOf(BadRequestException);
    prisma.$transaction.mockRejectedValueOnce(new Error('db'));
    await expect(service.mute('conv', 'org', 'author', 'ALL', '1h')).rejects.toThrow('db');
  });
  it('F4 lista vazio e nomes, cria nota com auditoria sem criar mensagem', async () => {
    const { service, prisma } = fixture();
    expect(await service.notes('conv', 'org', 'ALL')).toEqual([]);
    const created = await service.createNote('conv', 'org', 'author', 'ALL', 'nota');
    expect(created).toMatchObject({ id: 'note', authorName: 'Autor' });
    expect(prisma.conversationAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'INTERNAL_NOTE_CREATED' }) }));
    prisma.internalNote.findMany.mockResolvedValue([created]);
    expect(await service.notes('conv', 'org', 'ALL')).toEqual([expect.objectContaining({ authorName: 'Autor' })]);
    expect(prisma.internalNote.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
  });
  it.each(['', ' '.repeat(3), 'x'.repeat(4001), null, 42])('F4 rejeita conteúdo inválido (caso %#)', async content => {
    await expect(fixture().service.createNote('conv', 'org', 'author', 'ALL', content)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('F4 só permite ao autor alterar/apagar, escopa nota à conversa e audita', async () => {
    const { service, prisma } = fixture();
    prisma.internalNote.findFirst.mockResolvedValue({ id: 'note', authorId: 'other' });
    await expect(service.updateNote('conv', 'org', 'author', 'ALL', 'note', 'nova')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.deleteNote('conv', 'org', 'author', 'ALL', 'note')).rejects.toBeInstanceOf(ForbiddenException);
    prisma.internalNote.findFirst.mockResolvedValue({ id: 'note', authorId: 'author' });
    prisma.internalNote.update.mockResolvedValue({ id: 'note', authorId: 'author', content: 'nova' });
    expect(await service.updateNote('conv', 'org', 'author', 'ALL', 'note', 'nova')).toMatchObject({ content: 'nova', authorName: 'Autor' });
    await service.deleteNote('conv', 'org', 'author', 'ALL', 'note');
    expect(prisma.internalNote.findFirst).toHaveBeenCalledWith({ where: { id: 'note', conversationId: 'conv', conversation: { organizationId: 'org' } } });
    expect(prisma.conversationAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'INTERNAL_NOTE_DELETED' }) }));
  });
  it('F4 nota ausente e erro de banco não viram sucesso', async () => {
    const { service, prisma } = fixture();
    prisma.internalNote.findFirst.mockResolvedValue(null);
    await expect(service.deleteNote('conv', 'org', 'author', 'ALL', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    prisma.internalNote.findMany.mockRejectedValueOnce(new Error('db'));
    await expect(service.notes('conv', 'org', 'ALL')).rejects.toThrow('db');
  });
  it('F8 lista canais acessíveis com identidade, abre e cria vínculo do mesmo contato', async () => {
    const { service, prisma } = fixture();
    expect(await service.sendChannels('conv', 'org', 'ALL')).toEqual([
      { channelId: 'wa', name: 'WhatsApp', type: 'WHATSAPP_ZAPPFY', current: true, conversationId: 'conv', available: true, reason: null },
      { channelId: 'mail', name: 'E-mail', type: 'GMAIL', current: false, conversationId: null, available: true, reason: null },
    ]);
    expect(await service.openChannel('conv', 'org', 'author', 'ALL', 'mail')).toEqual({ conversationId: 'new' });
    expect(prisma.contactChannel.create).toHaveBeenCalledWith({ data: { channelId: 'mail', contactId: 'person', externalId: 'person@example.test' } });
    expect(prisma.conversation.create).toHaveBeenCalledWith({ data: { organizationId: 'org', channelId: 'mail', contactId: 'person', isGroup: false, status: 'PENDING' } });
  });
  it('F8 inclui canal atual não trocável com motivo e preserva filtros de acesso', async () => {
    const { service, prisma, conversation } = fixture();
    conversation.channelId = 'ig';
    prisma.channel.findMany.mockResolvedValue([{ id: 'ig', name: 'Instagram', type: 'INSTAGRAM', isActive: true }]);
    expect(await service.sendChannels('conv', 'org', new Set(['ig']))).toEqual([
      expect.objectContaining({ channelId: 'ig', current: true, conversationId: 'conv', available: false, reason: expect.any(String) }),
    ]);
    expect(prisma.channel.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      organizationId: 'org', deletedAt: null, id: { in: ['ig'] },
      OR: [{ type: { in: ['WHATSAPP_ZAPPFY', 'WHATSAPP_OFFICIAL', 'GMAIL'] } }, { id: 'ig' }],
    } }));
    await expect(service.openChannel('conv', 'org', 'author', new Set(['ig']), 'ig')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('F8 reusa arquivada e pula extras mescladas sem criar', async () => {
    const { service, prisma } = fixture();
    prisma.conversation.findMany.mockResolvedValue([{ id: 'merged', metadata: { cleanup_merged_into: 'original' } }, { id: 'original', isArchived: true, metadata: {} }]);
    expect(await service.openChannel('conv', 'org', 'author', 'ALL', 'mail')).toEqual({ conversationId: 'original' });
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });
  it('F8 duas aberturas concorrentes compartilham lock e não duplicam conversa', async () => {
    const { service, prisma, locks } = fixture();
    let pending = Promise.resolve();
    locks.withLock.mockImplementation((_key: string, fn: () => Promise<void>) => {
      const result = pending.then(fn);
      pending = result;
      return result;
    });
    const stored: any[] = [];
    prisma.conversation.findMany.mockImplementation(async () => [...stored]);
    prisma.conversation.create.mockImplementation(async () => {
      const row = { id: 'same', metadata: {} };
      stored.push(row);
      return row;
    });
    const results = await Promise.all([service.openChannel('conv', 'org', 'author', 'ALL', 'mail'), service.openChannel('conv', 'org', 'author', 'ALL', 'mail')]);
    expect(results).toEqual([{ conversationId: 'same' }, { conversationId: 'same' }]);
    expect(prisma.conversation.create).toHaveBeenCalledTimes(1);
    expect(locks.withLock).toHaveBeenCalledWith('conv:mail:person', expect.any(Function));
  });
  it('F8 grupo indisponível; canal sem identidade/inativo não abre', async () => {
    const { service, conversation, prisma } = fixture();
    conversation.isGroup = true;
    expect((await service.sendChannels('conv', 'org', 'ALL')).every(c => !c.available && !!c.reason)).toBe(true);
    await expect(service.openChannel('conv', 'org', 'author', 'ALL', 'mail')).rejects.toBeInstanceOf(BadRequestException);
    conversation.isGroup = false;
    conversation.contact.email = '';
    expect((await service.sendChannels('conv', 'org', 'ALL'))[1]).toMatchObject({ available: false });
    await expect(service.openChannel('conv', 'org', 'author', 'ALL', 'mail')).rejects.toBeInstanceOf(BadRequestException);
    prisma.channel.findMany.mockResolvedValue([]);
    expect(await service.sendChannels('conv', 'org', 'ALL')).toEqual([]);
    await expect(service.openChannel('conv', 'org', 'author', 'ALL', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('F8 não toma identidade de outro contato; falha de persistência é visível', async () => {
    const { service, prisma } = fixture();
    prisma.contactChannel.findFirst.mockResolvedValue({ contactId: 'other' });
    await expect(service.openChannel('conv', 'org', 'author', 'ALL', 'mail')).rejects.toBeInstanceOf(BadRequestException);
    prisma.contactChannel.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockRejectedValueOnce(new Error('db'));
    await expect(service.openChannel('conv', 'org', 'author', 'ALL', 'mail')).rejects.toThrow('db');
  });
  it.each(['mute', 'notes', 'createNote', 'updateNote', 'deleteNote', 'sendChannels', 'openChannel'])('%s recusa org/canal alheio antes de efeitos', async method => {
    const { service, prisma, conversation } = fixture();
    const args: Record<string, any[]> = { mute: ['author', new Set(), 'off'], notes: [new Set()], createNote: ['author', new Set(), 'nota'], updateNote: ['author', new Set(), 'note', 'nota'], deleteNote: ['author', new Set(), 'note'], sendChannels: [new Set()], openChannel: ['author', new Set(), 'mail'] };
    await expect((service as any)[method]('conv', 'other', ...args[method])).rejects.toBeInstanceOf(NotFoundException);
    await expect((service as any)[method]('conv', 'org', ...args[method])).rejects.toBeInstanceOf(ForbiddenException);
    conversation.metadata = { cleanup_merged_into: 'original' } as any;
    const allowedArgs = args[method].map(a => a instanceof Set ? 'ALL' : a);
    await expect((service as any)[method]('conv', 'org', ...allowedArgs)).rejects.toMatchObject({ status: 422 });
    expect(prisma.internalNote.create).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
});
