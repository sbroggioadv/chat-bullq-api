import { ContextEnrichmentService } from './context-enrichment.service';

describe('isolamento do enriquecimento de contexto', () => {
  const input = { organizationId: 'org-b', agentId: 'agent-b', conversationId: 'conv-a', contactId: 'contact-a' };
  it('recusa conversa de outro espaço antes de ler mensagens ou memória', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) }, contact: { findUnique: jest.fn() }, aiAgent: { findFirst: jest.fn().mockResolvedValue({ id: 'agent-b' }) }, message: { findMany: jest.fn().mockResolvedValue([]) } };
    const memory = { findOne: jest.fn() };
    await expect(new ContextEnrichmentService(prisma as any, memory as any).enrich(input as any)).rejects.toThrow();
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(memory.findOne).not.toHaveBeenCalled();
  });
  it('preserva contexto de recursos do próprio espaço', async () => {
    const conversation = { channel: { type: 'WEB', name: 'Canal' }, contact: { name: 'Pessoa' } };
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue(conversation) }, aiAgent: { findFirst: jest.fn().mockResolvedValue({ id: 'agent-b' }) }, message: { findMany: jest.fn().mockResolvedValue([]) } };
    const memory = { findOne: jest.fn().mockResolvedValue(null) };
    const result = await new ContextEnrichmentService(prisma as any, memory as any).enrich(input as any);
    expect(result.contact.name).toBe('Pessoa');
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conv-a', contactId: 'contact-a', organizationId: 'org-b' } }));
  });
});
