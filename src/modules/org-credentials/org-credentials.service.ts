import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AiCapability,
  AiProvider,
  CredentialAuditAction,
  CredentialTestStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from './crypto.service';
import { CredentialAuditService, AuditContext } from './audit.service';
import { testProviderKey } from './providers/credential-tester';
import {
  CredentialChangedPayload,
  CredentialEventsBus,
} from './credential-events';

@Injectable()
export class OrgCredentialsService {
  private readonly logger = new Logger(OrgCredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: CredentialAuditService,
    private readonly events: CredentialEventsBus,
  ) {}

  /**
   * Lista credentials da org, sempre mascarado. Plaintext key NUNCA sai
   * deste service — só decrypt() pra uso interno via getDecryptedKey().
   */
  async listMasked(organizationId: string) {
    const rows = await this.prisma.organizationCredential.findMany({
      where: { organizationId },
      orderBy: { provider: 'asc' },
      select: {
        id: true,
        provider: true,
        keyHint: true,
        lastTestAt: true,
        lastTestStatus: true,
        lastTestError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows;
  }

  /**
   * Cria ou atualiza credential pra um provider (upsert via unique
   * (orgId, provider)).
   */
  async upsert(
    organizationId: string,
    provider: AiProvider,
    plaintextKey: string,
    actorUserId: string,
    auditMeta: Pick<AuditContext, 'ip' | 'userAgent'> = {},
  ) {
    const encryptedKey = this.crypto.encrypt(plaintextKey);
    const keyHint = CryptoService.hint(plaintextKey);

    const existing = await this.prisma.organizationCredential.findUnique({
      where: {
        organizationId_provider: { organizationId, provider },
      },
    });

    const row = await this.prisma.organizationCredential.upsert({
      where: {
        organizationId_provider: { organizationId, provider },
      },
      create: {
        organizationId,
        provider,
        encryptedKey,
        keyHint,
        createdById: actorUserId,
        lastTestStatus: CredentialTestStatus.UNTESTED,
      },
      update: {
        encryptedKey,
        keyHint,
        // Atualizou key → invalida último teste (forçar re-test).
        lastTestStatus: CredentialTestStatus.UNTESTED,
        lastTestAt: null,
        lastTestError: null,
      },
      select: {
        id: true,
        provider: true,
        keyHint: true,
        lastTestAt: true,
        lastTestStatus: true,
        lastTestError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await this.audit.log({
      organizationId,
      actorUserId,
      action: existing ? CredentialAuditAction.UPDATED : CredentialAuditAction.CREATED,
      provider,
      ...auditMeta,
    });

    this.events.emit({ organizationId, provider } satisfies CredentialChangedPayload);

    return row;
  }

  async remove(
    organizationId: string,
    provider: AiProvider,
    actorUserId: string,
    auditMeta: Pick<AuditContext, 'ip' | 'userAgent'> = {},
  ) {
    const existing = await this.prisma.organizationCredential.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
    });
    if (!existing) {
      throw new NotFoundException(`No credential for ${provider}`);
    }

    // Safety: se o routing aponta pra esse provider e não há env fallback
    // configurado, bloquear (deixar org sem capability funcional é UX ruim).
    // Por enquanto deixamos passar — fallback gracioso no resolver cobre.
    await this.prisma.organizationCredential.delete({
      where: { organizationId_provider: { organizationId, provider } },
    });

    await this.audit.log({
      organizationId,
      actorUserId,
      action: CredentialAuditAction.DELETED,
      provider,
      ...auditMeta,
    });

    this.events.emit({ organizationId, provider } satisfies CredentialChangedPayload);

    return { deleted: true };
  }

  /**
   * Testa a credential ativa do provider. Atualiza lastTestStatus + error.
   * Rate-limited via decorator no controller (10/min/org).
   */
  async test(
    organizationId: string,
    provider: AiProvider,
    actorUserId: string,
    auditMeta: Pick<AuditContext, 'ip' | 'userAgent'> = {},
  ) {
    const row = await this.prisma.organizationCredential.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
    });
    if (!row) throw new NotFoundException(`No credential for ${provider}`);

    const plaintext = this.crypto.decrypt(row.encryptedKey);
    const result = await testProviderKey(provider, plaintext, this.logger);
    // Limpar plaintext da memória ASAP (best-effort, GC will reclaim).
    (plaintext as unknown as { length: number }).length;

    const updated = await this.prisma.organizationCredential.update({
      where: { organizationId_provider: { organizationId, provider } },
      data: {
        lastTestAt: new Date(),
        lastTestStatus: result.ok
          ? CredentialTestStatus.SUCCESS
          : CredentialTestStatus.FAILURE,
        lastTestError: result.ok ? null : (result.error ?? 'Unknown error'),
      },
      select: {
        id: true,
        provider: true,
        keyHint: true,
        lastTestAt: true,
        lastTestStatus: true,
        lastTestError: true,
      },
    });

    await this.audit.log({
      organizationId,
      actorUserId,
      action: result.ok
        ? CredentialAuditAction.TESTED_SUCCESS
        : CredentialAuditAction.TESTED_FAILURE,
      provider,
      detail: result.ok ? undefined : result.error,
      ...auditMeta,
    });

    return updated;
  }

  /**
   * USO INTERNO APENAS — chamado pelo ProviderResolverService.
   * Retorna plaintext key (decifrada) OU null se org não tem credential
   * pra esse provider.
   *
   * Nunca expor via HTTP. Não logar valor.
   */
  async getDecryptedKey(
    organizationId: string,
    provider: AiProvider,
  ): Promise<string | null> {
    const row = await this.prisma.organizationCredential.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
      select: { encryptedKey: true },
    });
    if (!row) return null;
    return this.crypto.decrypt(row.encryptedKey);
  }

  // ─── Capability routing ─────────────────────────────────────────

  async listRouting(organizationId: string) {
    const rows = await this.prisma.organizationCapabilityRouting.findMany({
      where: { organizationId },
      orderBy: { capability: 'asc' },
    });
    // Sanity: garante que as 3 capabilities aparecem mesmo se seed faltou
    // (defensive — não deveria acontecer pós-migration).
    const map = new Map(rows.map((r) => [r.capability, r]));
    const defaults: Record<AiCapability, AiProvider> = {
      LLM_AGENT: AiProvider.ANTHROPIC,
      TRANSCRIPTION: AiProvider.OPENAI,
      EMBEDDINGS: AiProvider.OPENAI,
    };
    return (Object.keys(defaults) as AiCapability[]).map((cap) => {
      const existing = map.get(cap);
      return (
        existing ?? {
          organizationId,
          capability: cap,
          providerSelected: defaults[cap],
          modelOverride: null,
          updatedAt: new Date(),
        }
      );
    });
  }

  async updateRouting(
    organizationId: string,
    entries: Array<{
      capability: AiCapability;
      providerSelected: AiProvider;
      modelOverride?: string;
    }>,
    actorUserId: string,
    auditMeta: Pick<AuditContext, 'ip' | 'userAgent'> = {},
  ) {
    // Validação semântica: EMBEDDINGS só permite OPENAI por enquanto
    // (Anthropic não tem endpoint público, Gemini fica pra V2).
    for (const entry of entries) {
      if (
        entry.capability === AiCapability.EMBEDDINGS &&
        entry.providerSelected !== AiProvider.OPENAI
      ) {
        throw new ConflictException(
          'EMBEDDINGS capability currently only supports OPENAI',
        );
      }
      if (
        entry.capability === AiCapability.TRANSCRIPTION &&
        entry.providerSelected === AiProvider.ANTHROPIC
      ) {
        throw new ConflictException(
          'TRANSCRIPTION capability not supported on ANTHROPIC',
        );
      }
    }

    const previous = await this.listRouting(organizationId);
    const previousMap = new Map(previous.map((p) => [p.capability, p]));

    const results = await this.prisma.$transaction(
      entries.map((entry) =>
        this.prisma.organizationCapabilityRouting.upsert({
          where: {
            organizationId_capability: {
              organizationId,
              capability: entry.capability,
            },
          },
          create: {
            organizationId,
            capability: entry.capability,
            providerSelected: entry.providerSelected,
            modelOverride: entry.modelOverride,
          },
          update: {
            providerSelected: entry.providerSelected,
            modelOverride: entry.modelOverride,
          },
        }),
      ),
    );

    // Audit per-entry pra trail granular
    for (const entry of entries) {
      const prev = previousMap.get(entry.capability);
      if (prev && prev.providerSelected !== entry.providerSelected) {
        await this.audit.log({
          organizationId,
          actorUserId,
          action: CredentialAuditAction.ROUTING_CHANGED,
          provider: entry.providerSelected,
          detail: `${entry.capability}: ${prev.providerSelected} -> ${entry.providerSelected}${
            entry.modelOverride ? ` (model=${entry.modelOverride})` : ''
          }`,
          ...auditMeta,
        });
      }
    }

    // Invalidar cache de resolver pra todas as orgs envolvidas
    for (const entry of entries) {
      this.events.emit({
        organizationId,
        provider: entry.providerSelected,
      } satisfies CredentialChangedPayload);
    }

    return results;
  }
}
