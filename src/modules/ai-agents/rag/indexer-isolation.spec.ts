import { RagIndexerProcessor } from './indexer.processor';

describe('credencial de embeddings no job RAG', () => {
  it('usa organização do job para escolher credencial', async () => {
    const embeddings = { embed: jest.fn().mockResolvedValue({ vector: [1], model: 'teste', tokensUsed: 1, costUsd: 0 }) };
    const store = { upsert: jest.fn() };
    const processor = new RagIndexerProcessor(embeddings as any, store as any);
    await processor.process({ data: { type: 'index_message', messageId: 'm', content: 'texto', organizationId: 'org-a', scope: { conversationId: 'c' } } } as any);
    expect(embeddings.embed).toHaveBeenCalledWith('texto', 'org-a');
  });
  it('recusa job antigo sem organização antes do provedor', async () => {
    const embeddings = { embed: jest.fn() };
    const processor = new RagIndexerProcessor(embeddings as any, {} as any);
    await expect(processor.process({ data: { type: 'index_message', messageId: 'm', content: 'texto', scope: {} } } as any)).rejects.toThrow();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });
});
