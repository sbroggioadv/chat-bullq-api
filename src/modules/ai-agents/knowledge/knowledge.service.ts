import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { EmbeddingsService } from '../rag/embeddings.service';
import { VectorStoreService } from '../rag/vector-store.service';
import {
  chunkText,
  extractKnowledgeText,
  inferMime,
  isSupportedKnowledgeMime,
} from './extract-text';

const MAX_BYTES = 10 * 1024 * 1024;

export type KnowledgeDocView = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  errorMessage: string | null;
  chunkCount: number;
  createdAt: Date;
};

@Injectable()
export class AgentKnowledgeService {
  private readonly rootDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
    private readonly vectors: VectorStoreService,
    config: ConfigService,
  ) {
    this.rootDir = path.resolve(
      config.get<string>('UPLOADS_DIR') || path.join(process.cwd(), 'uploads'),
    );
  }

  async list(organizationId: string, agentId: string): Promise<KnowledgeDocView[]> {
    await this.assertAgent(organizationId, agentId);
    const rows = await this.prisma.aiAgentKnowledgeDoc.findMany({
      where: { organizationId, agentId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async upload(
    organizationId: string,
    agentId: string,
    file: { buffer: Buffer; originalname?: string; mimetype?: string },
  ): Promise<KnowledgeDocView> {
    await this.assertAgent(organizationId, agentId);
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Arquivo vazio');
    }
    if (file.buffer.byteLength > MAX_BYTES) {
      throw new BadRequestException('Arquivo grande demais (máx. 10 MB)');
    }
    const fileName = (file.originalname || 'documento').replace(
      /[^a-zA-Z0-9._\-\sÀ-ÿ]/g,
      '_',
    );
    const mimeType = inferMime(fileName, file.mimetype);
    if (!isSupportedKnowledgeMime(mimeType, fileName)) {
      throw new BadRequestException(
        'Formato não suportado. Use PDF, DOCX, Markdown ou TXT.',
      );
    }

    const dir = path.join(this.rootDir, 'knowledge', agentId);
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomBytes(12).toString('hex');
    const ext = path.extname(fileName) || '';
    const storagePath = path.join('knowledge', agentId, `${id}${ext}`);
    fs.writeFileSync(path.join(this.rootDir, storagePath), file.buffer);

    const doc = await this.prisma.aiAgentKnowledgeDoc.create({
      data: {
        organizationId,
        agentId,
        fileName,
        mimeType,
        sizeBytes: file.buffer.byteLength,
        storagePath,
        status: 'INDEXING',
      },
    });

    try {
      const text = await extractKnowledgeText(file.buffer, fileName, mimeType);
      const chunks = chunkText(text);
      if (!chunks.length) {
        throw new BadRequestException(
          'O arquivo não tem texto extraível. PDFs só-imagem não entram na base.',
        );
      }
      const BATCH = 16;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const embeddings = await this.embeddings.embedBatch(
          slice,
          organizationId,
        );
        for (let j = 0; j < slice.length; j++) {
          const idx = i + j;
          const emb = embeddings[j];
          await this.vectors.upsert({
            id: `knowledge_doc:${doc.id}:${idx}`,
            ownerType: 'knowledge_doc',
            ownerId: `${doc.id}:${idx}`,
            agentId,
            content: slice[j],
            embedding: emb.vector,
            metadata: {
              documentId: doc.id,
              fileName,
              chunkIndex: idx,
              embeddingModel: emb.model,
            },
            createdAt: new Date().toISOString(),
          });
        }
      }
      const ready = await this.prisma.aiAgentKnowledgeDoc.update({
        where: { id: doc.id },
        data: { status: 'READY', chunkCount: chunks.length, errorMessage: null },
      });
      return this.toView(ready);
    } catch (err) {
      const message =
        err instanceof BadRequestException
          ? String(err.message)
          : this.friendlyEmbedError(err);
      const failed = await this.prisma.aiAgentKnowledgeDoc.update({
        where: { id: doc.id },
        data: { status: 'FAILED', errorMessage: message },
      });
      return this.toView(failed);
    }
  }

  async remove(organizationId: string, agentId: string, docId: string) {
    await this.assertAgent(organizationId, agentId);
    const doc = await this.prisma.aiAgentKnowledgeDoc.findFirst({
      where: { id: docId, agentId, organizationId, deletedAt: null },
    });
    if (!doc) throw new NotFoundException('Documento não encontrado');
    await this.vectors.deleteByMetadata('documentId', doc.id);
    await this.prisma.aiAgentKnowledgeDoc.update({
      where: { id: doc.id },
      data: { deletedAt: new Date(), status: 'DELETED' },
    });
    const full = path.join(this.rootDir, doc.storagePath);
    fs.unlink(full, () => undefined);
    return { ok: true };
  }

  private async assertAgent(organizationId: string, agentId: string) {
    const agent = await this.prisma.aiAgent.findFirst({
      where: { id: agentId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('Agente não encontrado');
  }

  private toView(row: {
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    errorMessage: string | null;
    chunkCount: number;
    createdAt: Date;
  }): KnowledgeDocView {
    return {
      id: row.id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      status: row.status,
      errorMessage: row.errorMessage,
      chunkCount: row.chunkCount,
      createdAt: row.createdAt,
    };
  }

  private friendlyEmbedError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (/OPENAI_API_KEY|No credential|embeddings|401|403/i.test(raw)) {
      return 'Embeddings não configurados. Em Credenciais de IA, roteie Embeddings para Sakana Fugu (formato OpenAI) ou OpenAI e anexe de novo.';
    }
    return raw.slice(0, 400);
  }
}
