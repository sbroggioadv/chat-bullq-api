import { MemoryExtractorProcessor } from './memory-extractor.processor';
import { MemoryExtractorService } from './memory-extractor.service';

describe('credencial de memória por espaço', () => {
  it('recusa job sem organização antes de consultar dados', async () => {
    const prisma = { conversation: { findFirst: jest.fn() }, message: { findMany: jest.fn().mockResolvedValue([]) } };
    const processor = new MemoryExtractorProcessor({} as any, {} as any, prisma as any);
    await expect(processor.process({ data: { agentId: 'ag', contactId: 'co', conversationId: 'cv' } } as any)).rejects.toThrow();
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });
  it('processa conversa e agente do próprio espaço', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'cv' }) }, aiAgent: { findFirst: jest.fn().mockResolvedValue({ id: 'ag' }) }, message: { findMany: jest.fn().mockResolvedValue([{ direction: 'INBOUND', content: { text: 'olá' }, createdAt: new Date() }]) } };
    const memory = { getOrCreate: jest.fn().mockResolvedValue(null) };
    const extractor = { extract: jest.fn().mockResolvedValue({ newFacts: [], factsToRemove: [], summaryUpdate: null, costUsd: 0 }) };
    const processor = new MemoryExtractorProcessor(extractor as any, memory as any, prisma as any);
    expect(await processor.process({ data: { organizationId: 'org-a', agentId: 'ag', contactId: 'co', conversationId: 'cv' } } as any)).toEqual({ ok: true, factsAdded: 0, factsRemoved: 0, costUsd: 0 });
    expect(extractor.extract).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a' }));
  });
  it('encaminha organização para o roteador de credenciais', async () => {
    const llm = { complete: jest.fn().mockResolvedValue({ message: { content: '{}' }, usage: { costUsd: 0 } }) };
    const svc = new MemoryExtractorService(llm as any);
    await svc.extract({ organizationId: 'org-a', agentId: 'ag', contactId: 'co', recentMessages: [], currentMemory: null } as any);
    expect(llm.complete).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a' }));
  });
});
