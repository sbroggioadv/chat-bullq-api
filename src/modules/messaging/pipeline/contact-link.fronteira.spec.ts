import { ContactResolverService } from './contact-resolver.service';
import { HistoryImportService } from './history-import.service';
import { JarvisDeskService } from '../../jarvis-desk/jarvis-desk.service';

describe('vínculo de contato preexistente entre organizações', () => {
  it('entrada recusa contato alheio antes de alterar ou criar conversa', async () => {
    const prisma: any = { contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'link', contactId: 'contact-a', contact: { organizationId: 'org-a' } }) } };
    const service = new ContactResolverService(prisma, {} as any);
    await expect(service.resolve('org-b', 'channel-b', { externalContactId: 'synthetic' } as any)).rejects.toThrow('cross_org_contact_channel');
  });
  it('importação recusa contato alheio antes de criar conversa', async () => {
    const prisma: any = { contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'link', contactId: 'contact-a', contact: { organizationId: 'org-a' } }) }, conversation: { create: jest.fn() } };
    const service = new HistoryImportService(prisma, {} as any);
    await expect(service.importConversation({ id: 'channel-b', organizationId: 'org-b' } as any, { externalContactId: 'synthetic' } as any)).rejects.toThrow('cross_org_contact_channel');
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });
  it('desk recusa contato alheio antes de criar conversa', async () => {
    const prisma: any = { channel: { findFirst: jest.fn().mockResolvedValue({ id: 'channel-b' }) }, contactChannel: { findFirst: jest.fn().mockResolvedValue({ contact: { id: 'contact-a', organizationId: 'org-a' } }) }, conversation: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() } };
    const service = new JarvisDeskService(prisma);
    await expect(service.ensureDesk('org-b')).rejects.toThrow('cross_org_contact_channel');
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });
  it('importação aceita contato da mesma organização', async () => {
    const prisma: any = { contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'link', contactId: 'contact-b', contact: { organizationId: 'org-b' } }) }, conversation: { findMany: jest.fn().mockResolvedValue([{ id: 'conv-b' }]) } };
    const service = new HistoryImportService(prisma, {} as any);
    await expect(service.importConversation({ id: 'channel-b', organizationId: 'org-b' } as any, { externalContactId: 'synthetic' } as any)).resolves.toMatchObject({ contactId: 'contact-b', conversationId: 'conv-b' });
  });
  it('desk aceita contato da mesma organização', async () => {
    const prisma: any = { channel: { findFirst: jest.fn().mockResolvedValue({ id: 'channel-b' }) }, contactChannel: { findFirst: jest.fn().mockResolvedValue({ contact: { id: 'contact-b', organizationId: 'org-b' } }) }, conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv-b', status: 'OPEN', isArchived: false }) } };
    const service = new JarvisDeskService(prisma);
    await expect(service.ensureDesk('org-b')).resolves.toMatchObject({ contactId: 'contact-b', conversationId: 'conv-b' });
  });
  it('entrada aceita contato da mesma organização', async () => {
    const prisma: any = { contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'link', contactId: 'contact-b', contact: { organizationId: 'org-b', name: null, phone: null } }) } };
    const service = new ContactResolverService(prisma, {} as any);
    await expect(service.resolve('org-b', 'channel-b', { externalContactId: 'synthetic' } as any)).resolves.toMatchObject({ contactId: 'contact-b' });
  });
});
