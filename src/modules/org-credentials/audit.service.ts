import { Injectable, Logger } from '@nestjs/common';
import {
  AiProvider,
  CredentialAuditAction,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface AuditContext {
  organizationId: string;
  actorUserId: string;
  action: CredentialAuditAction;
  provider?: AiProvider;
  /**
   * Texto livre pra contexto humano (ex "ANTHROPIC->OPENAI" pra routing).
   * NUNCA inclui plaintext key — apenas metadata estrutural.
   */
  detail?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Append-only audit log para todas mutações de credentials e routing.
 *
 * Por design, esta classe NUNCA expõe `update` ou `delete` — só `log()`.
 * Linhas auditadas são imutáveis. Para retenção LGPD/SOC, schedule um
 * job de archive externo (não implementado aqui).
 */
@Injectable()
export class CredentialAuditService {
  private readonly logger = new Logger(CredentialAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(ctx: AuditContext): Promise<void> {
    try {
      await this.prisma.organizationCredentialAudit.create({
        data: {
          organizationId: ctx.organizationId,
          actorUserId: ctx.actorUserId,
          action: ctx.action,
          provider: ctx.provider,
          detail: ctx.detail,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      });
    } catch (err) {
      // Audit failure não deve impedir mutação — só logar pra observability.
      // Se isso virar problema (audit log dropping), promover pra throw e
      // forçar rollback da operação.
      this.logger.error(
        `Audit log write failed for org=${ctx.organizationId} action=${ctx.action}: ${(err as Error).message}`,
      );
    }
  }

  async list(
    organizationId: string,
    opts: { limit?: number; before?: Date } = {},
  ) {
    return this.prisma.organizationCredentialAudit.findMany({
      where: {
        organizationId,
        ...(opts.before ? { createdAt: { lt: opts.before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
    });
  }
}
