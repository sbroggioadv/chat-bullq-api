import { ChannelType, ConversationStatus } from '@prisma/client';
import { HistoryImportService } from './history-import.service';

describe('HistoryImportService conversation resolution', () => {
  const lastMessageAt = new Date('2026-11-02T12:00:00Z');
  let prisma: any;
  let service: HistoryImportService;
  beforeEach(() => {
    prisma = {
      contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'cc', contactId: 'contact', profileName: 'Nome', contact: { organizationId: 'org' } }), update: jest.fn() },
      conversation: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn().mockResolvedValue({ id: 'new' }) },
      conversationAuditLog: { create: jest.fn() },
    };
    service = new HistoryImportService(prisma, {} as any);
  });
  const normalized: any = { externalContactId: 'contact-external', contactName: 'Nome', externalConversationId: 'thread', lastMessageAt };
  const channel = (type: ChannelType): any => ({ id: 'channel', organizationId: 'org', type });

  it('reuses an open WhatsApp conversation and preserves metadata', async () => {
    prisma.conversation.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'existing', lastMessageAt: null, metadata: { source: 'live' } });
    await expect(service.importConversation(channel(ChannelType.WHATSAPP_ZAPPFY), normalized)).resolves.toEqual({ conversationId: 'existing', contactId: 'contact', isNew: false });
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'existing' }, data: { metadata: { source: 'live', externalConversationId: 'thread' }, lastMessageAt } });
  });
  it('creates a separate Gmail thread', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(service.importConversation(channel(ChannelType.GMAIL), normalized)).resolves.toMatchObject({ conversationId: 'new', isNew: true });
    expect(prisma.conversation.findFirst).toHaveBeenCalledTimes(1);
  });
  it('creates a WhatsApp conversation if none is open', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(service.importConversation(channel(ChannelType.WHATSAPP_ZAPPFY), normalized)).resolves.toMatchObject({ conversationId: 'new', isNew: true });
    expect(prisma.conversation.findFirst).toHaveBeenCalledTimes(2);
  });
  it('does not reuse closed conversations', async () => {
    prisma.conversation.findFirst.mockImplementation(async ({ where }: any) => where.status?.in?.includes(ConversationStatus.CLOSED) ? { id: 'closed' } : null);
    await expect(service.importConversation(channel(ChannelType.WHATSAPP_ZAPPFY), normalized)).resolves.toMatchObject({ conversationId: 'new', isNew: true });
    expect(prisma.conversation.findFirst).toHaveBeenCalledTimes(2);
  });
});
