import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { AiAgent, Message } from '@prisma/client';

/**
 * Decide qual agente IA (se algum) foi invocado por uma mensagem inbound
 * de grupo. Critérios em ordem:
 *  1. Reply nativo: a msg tem `metadata.replyTo.messageId` apontando pra
 *     uma Message com `senderId IS NULL` (IA) e `metadata.aiAgentId`. O
 *     agente apontado responde.
 *  2. @handle no texto: regex `\B@handle\b` case-insensitive. Primeiro
 *     candidato com match.
 *  3. Nenhum dos dois → null.
 *
 * Defesas:
 *  - Handle null no agente é ignorado.
 *  - Handle com chars regex perigosos (apesar do DTO validar `[a-z0-9_-]+`)
 *    é escapado antes do RegExp.
 *  - `metadata.aiAgentId` em msg de IA precisa ser persistido pelo runner;
 *    msgs antigas sem esse campo simplesmente não matcham por reply.
 */
@Injectable()
export class GroupMentionDetector {
  constructor(private readonly prisma: PrismaService) {}

  async findMatchingAgent(
    message: Pick<Message, 'content' | 'metadata'>,
    candidates: Array<Pick<AiAgent, 'id' | 'mentionHandle'>>,
  ): Promise<Pick<AiAgent, 'id' | 'mentionHandle'> | null> {
    // 1) Reply nativo
    const replyMsgId = (message.metadata as any)?.replyTo?.messageId;
    if (typeof replyMsgId === 'string' && replyMsgId.length > 0) {
      const original = await this.prisma.message.findUnique({
        where: { id: replyMsgId },
        select: { id: true, senderId: true, metadata: true },
      });
      if (original && original.senderId === null) {
        const aiAgentId = (original.metadata as any)?.aiAgentId;
        if (typeof aiAgentId === 'string') {
          const matched = candidates.find((c) => c.id === aiAgentId);
          if (matched) return matched;
        }
      }
    }

    // 2) @handle no texto/caption
    const text = this.extractText(message.content);
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const agent of candidates) {
      if (!agent.mentionHandle) continue;
      const handle = agent.mentionHandle.toLowerCase();
      // Defesa: só aceita handles que combinam com o regex de validação
      // do DTO (`[a-z0-9_-]+`). Caso contrário ignora — protege contra
      // regex injection vindo do banco em estado inesperado.
      if (!/^[a-z0-9_-]+$/.test(handle)) continue;
      const pattern = new RegExp(`\\B@${handle}\\b`, 'i');
      if (pattern.test(lower)) return agent;
    }
    return null;
  }

  private extractText(content: any): string {
    if (!content) return '';
    if (typeof content.text === 'string') return content.text;
    if (typeof content.caption === 'string') return content.caption;
    return '';
  }
}
