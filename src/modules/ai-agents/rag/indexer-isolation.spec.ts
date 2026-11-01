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
  it.each(['index_knowledge_doc', 'delete_entry'])('recusa %s sem organização', async (type) => {
    const embeddings = { embedBatch: jest.fn().mockResolvedValue([{ vector: [1], model: 'test' }]) };
    const store = { upsert: jest.fn(), delete: jest.fn() };
    const processor = new RagIndexerProcessor(embeddings as any, store as any);
    await expect(processor.process({ data: { type, id: 'x', documentId: 'x', agentId: 'a', chunks: ['texto'] } } as any)).rejects.toThrow('Organização ausente');
    expect(embeddings.embedBatch).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });
  it('executa documento e exclusão quando o job tem organização', async () => {
    const embeddings = { embedBatch: jest.fn().mockResolvedValue([{ vector: [1], model: 'test' }]) };
    const store = { upsert: jest.fn(), delete: jest.fn() };
    const processor = new RagIndexerProcessor(embeddings as any, store as any);
    await processor.process({ data: { type: 'index_knowledge_doc', documentId: 'x', agentId: 'a', chunks: ['texto'], organizationId: 'A' } } as any);
    await processor.process({ data: { type: 'delete_entry', id: 'x', organizationId: 'A' } } as any);
    expect(embeddings.embedBatch).toHaveBeenCalledWith(['texto'], 'A');
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(store.delete).toHaveBeenCalledWith('x');
  });

});
