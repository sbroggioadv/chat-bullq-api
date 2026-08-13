import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentKnowledgeService } from './knowledge.service';

function makePrisma(agentExists = true) {
  const docs: any[] = [];
  return {
    docs,
    aiAgent: {
      findFirst: jest.fn(async () => (agentExists ? { id: 'ag1' } : null)),
    },
    aiAgentKnowledgeDoc: {
      findMany: jest.fn(async () => docs.filter((d) => !d.deletedAt)),
      findFirst: jest.fn(async ({ where }: any) =>
        docs.find((d) => d.id === where.id && !d.deletedAt) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 'doc1',
          createdAt: new Date(),
          chunkCount: 0,
          errorMessage: null,
          ...data,
        };
        docs.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = docs.find((d) => d.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
  };
}

describe('AgentKnowledgeService', () => {
  const embeddings = {
    embedBatch: jest.fn(async (chunks: string[]) =>
      chunks.map(() => ({ vector: [0.1, 0.2], model: 'test', tokensUsed: 1, costUsd: 0 })),
    ),
  };
  const vectors = {
    upsert: jest.fn(async () => undefined),
    deleteByMetadata: jest.fn(async () => undefined),
  };
  const config = { get: () => undefined };

  it('rejeita agente inexistente', async () => {
    const prisma = makePrisma(false);
    const svc = new AgentKnowledgeService(
      prisma as any,
      embeddings as any,
      vectors as any,
      config as any,
    );
    await expect(svc.list('org1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('indexa TXT e marca READY', async () => {
    const prisma = makePrisma(true);
    const svc = new AgentKnowledgeService(
      prisma as any,
      embeddings as any,
      vectors as any,
      config as any,
    );
    const result = await svc.upload('org1', 'ag1', {
      buffer: Buffer.from('Política de honorários: 20% sobre êxito.'),
      originalname: 'politica.txt',
      mimetype: 'text/plain',
    });
    expect(result.status).toBe('READY');
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(vectors.upsert).toHaveBeenCalled();
  });

  it('rejeita formato não suportado', async () => {
    const prisma = makePrisma(true);
    const svc = new AgentKnowledgeService(
      prisma as any,
      embeddings as any,
      vectors as any,
      config as any,
    );
    await expect(
      svc.upload('org1', 'ag1', {
        buffer: Buffer.from('PK'),
        originalname: 'foto.png',
        mimetype: 'image/png',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('falha de embedding vira FAILED com mensagem clara', async () => {
    const prisma = makePrisma(true);
    const badEmb = {
      embedBatch: jest.fn(async () => {
        throw new Error('No OPENAI_API_KEY set');
      }),
    };
    const svc = new AgentKnowledgeService(
      prisma as any,
      badEmb as any,
      vectors as any,
      config as any,
    );
    const result = await svc.upload('org1', 'ag1', {
      buffer: Buffer.from('Regra interna do escritório.'),
      originalname: 'regras.txt',
      mimetype: 'text/plain',
    });
    expect(result.status).toBe('FAILED');
    expect(result.errorMessage).toMatch(/Embeddings/i);
  });
});
