import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  AgentCreateData,
  CloneableAgent,
  computeParentUpdates,
  planAgentClone,
  PlannedAgentCreate,
} from './agent-clone.planner';
import {
  ProvisionAgentResult,
  ProvisionResult,
  ProvisionTenantInput,
} from './dto/provision-tenant.input';

/** Marcador gravado em Organization.settings pra idempotência do provisionamento. */
export const PROVISION_MARKER = 'provision-tenant-script';

/**
 * TenantProvisioningService — provisiona uma organização NOVA e ISOLADA,
 * convida o admin (que define a própria senha) e clona um squad de agentes
 * de uma org-fonte, preservando a hierarquia orquestrador→workers.
 *
 * Injetável: serve tanto ao script CLI quanto a um futuro endpoint
 * self-service/admin do Aquecia (billing/reseller entram como camada acima
 * deste service — ver comentários "AQUECIA:").
 *
 * A fronteira de multi-tenancy do sistema (todo dado é escopado por
 * organizationId) garante o isolamento: a org nova não enxerga dados de
 * nenhuma outra.
 */
@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
  ) {}

  async provision(
    input: ProvisionTenantInput,
    opts: { dryRun?: boolean } = {},
  ): Promise<ProvisionResult> {
    const dryRun = opts.dryRun ?? false;
    this.validateInput(input);

    const adminRole = input.adminRole ?? OrgRole.OWNER;
    const label = dryRun ? '[DRY-RUN] ' : '';
    this.logger.log(
      `${label}Provisionando tenant "${input.tenantName}" (admin=${input.adminEmail}, role=${adminRole})`,
    );

    // AQUECIA: aqui entraria o gate de billing/plano (pode criar org? quota
    // de agentes? plano permite N seats?) antes de qualquer escrita.

    // ── 1. Org isolada (idempotente) ────────────────────────────
    const existingOrg = await this.findProvisionedOrg(
      input.tenantName,
      input.adminEmail,
    );
    let orgId: string | null = existingOrg?.id ?? null;
    let orgSlug: string | null = existingOrg?.slug ?? null;
    const orgReused = existingOrg !== null;

    if (existingOrg) {
      this.logger.log(
        `${label}Org já provisionada antes (id=${existingOrg.id}) — reusando, sem duplicar`,
      );
    } else if (!dryRun) {
      const created = await this.createIsolatedOrg(input);
      orgId = created.id;
      orgSlug = created.slug;
      this.logger.log(`Org criada: id=${orgId} slug=${orgSlug}`);
    } else {
      this.logger.log(
        `${label}Criaria org nova "${input.tenantName}" + department "Geral" default`,
      );
    }

    // ── 2. Clona o squad de agentes ─────────────────────────────
    const agents = await this.cloneAgents(input, orgId, dryRun);

    // ── 3. Convida o admin (reusa OrganizationsService.inviteMember) ──
    const invitation = await this.inviteAdmin(
      input,
      orgId,
      adminRole,
      dryRun,
    );

    // ── 4. WhatsApp — NÃO provisiona canal ──────────────────────
    const whatsapp = this.describeWhatsappStep(input.whatsappNumber ?? null);
    if (input.whatsappNumber) {
      this.logger.log(
        `${label}WhatsApp ${input.whatsappNumber}: setup manual do canal Zappfy pela UI (auto-registra webhook). Script NÃO cria instância.`,
      );
    }

    return {
      dryRun,
      organization: {
        id: orgId,
        name: input.tenantName,
        slug: orgSlug,
        reused: orgReused,
      },
      invitation,
      agents,
      whatsapp,
    };
  }

  // ─── Validação ──────────────────────────────────────────────

  private validateInput(input: ProvisionTenantInput): void {
    if (!input.tenantName || input.tenantName.trim().length < 2) {
      throw new ConflictException('tenantName inválido (mín. 2 caracteres)');
    }
    // Valida forma básica do e-mail — a checagem forte fica no fluxo de
    // convite/registro. Aqui só evita lixo óbvio.
    if (!input.adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminEmail)) {
      throw new ConflictException('adminEmail inválido');
    }
  }

  // ─── Org isolada ────────────────────────────────────────────

  /**
   * Idempotência: acha uma org já provisionada por este script pro mesmo
   * (nome, e-mail do admin) via o marcador em settings. Evita duplicar em
   * re-execuções.
   */
  private async findProvisionedOrg(
    tenantName: string,
    adminEmail: string,
  ): Promise<{ id: string; slug: string } | null> {
    const org = await this.prisma.organization.findFirst({
      where: {
        deletedAt: null,
        name: tenantName.trim(),
        settings: {
          path: ['provisioning', 'for'],
          equals: adminEmail,
        },
      },
      select: { id: true, slug: true },
    });
    return org;
  }

  /**
   * Cria org + department "Geral" default numa transação. Sem OWNER/membro:
   * o admin entra ao aceitar o convite (auth.registerWithInvite cria a
   * membership e vincula ao department default). Espelha createWorkspace,
   * menos a parte de owner.
   */
  private async createIsolatedOrg(
    input: ProvisionTenantInput,
  ): Promise<{ id: string; slug: string }> {
    const slug = this.generateSlug(input.tenantName);
    const settings: Prisma.InputJsonValue = {
      provisioning: {
        via: PROVISION_MARKER,
        for: input.adminEmail,
        at: new Date().toISOString(),
      },
    };

    return this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.tenantName.trim(),
          slug,
          settings,
        },
        select: { id: true, slug: true },
      });

      await tx.department.create({
        data: {
          organizationId: org.id,
          name: 'Geral',
          description: 'Departamento padrao',
          isDefault: true,
        },
      });

      return org;
    });
  }

  /** Slug determinístico: mesmo padrão do OrganizationsService/auth. */
  private generateSlug(name: string): string {
    const base = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    return `${base || 'workspace'}-${Date.now().toString(36)}`;
  }

  // ─── Convite do admin ───────────────────────────────────────

  private async inviteAdmin(
    input: ProvisionTenantInput,
    orgId: string | null,
    adminRole: OrgRole,
    dryRun: boolean,
  ): Promise<ProvisionResult['invitation']> {
    if (dryRun || !orgId) {
      const inviterHint = input.inviterUserId ?? `(owner de ${input.sourceOrgId ?? '—'})`;
      this.logger.log(
        `[DRY-RUN] Convidaria ${input.adminEmail} como ${adminRole} (inviter=${inviterHint}). Admin define a própria senha pelo link.`,
      );
      return {
        email: input.adminEmail,
        role: adminRole,
        status: 'DRY_RUN',
        token: null,
      };
    }

    const inviterId = await this.resolveInviter(input);

    try {
      const result = await this.organizations.inviteMember(
        orgId,
        { email: input.adminEmail, role: adminRole },
        inviterId,
      );
      // inviteMember retorna autoAccepted=true quando o e-mail já é um user
      // existente (adiciona direto). Nesse caso não há link de senha.
      const autoAccepted =
        'autoAccepted' in result ? result.autoAccepted === true : false;
      const token =
        'token' in result && typeof result.token === 'string'
          ? result.token
          : null;
      this.logger.log(
        `Convite ${autoAccepted ? 'auto-aceito (user já existia)' : 'criado'} para ${input.adminEmail}`,
      );
      return {
        email: input.adminEmail,
        role: adminRole,
        status: autoAccepted ? 'AUTO_ACCEPTED' : 'CREATED',
        token: autoAccepted ? null : token,
      };
    } catch (err) {
      if (err instanceof ConflictException) {
        // Já é membro — re-execução idempotente.
        this.logger.log(
          `${input.adminEmail} já é membro de ${orgId} — convite ignorado (idempotente)`,
        );
        return {
          email: input.adminEmail,
          role: adminRole,
          status: 'ALREADY_MEMBER',
          token: null,
        };
      }
      throw err;
    }
  }

  /**
   * Resolve o usuário que "envia" o convite (FK Invitation.invitedById).
   * Prioriza input.inviterUserId; senão usa o OWNER da org-fonte. Numa org
   * nova ainda não há membros, então o inviter tem que ser um user já
   * existente do sistema.
   *
   * AQUECIA: aqui entraria o "system user" da conta reseller/admin.
   */
  private async resolveInviter(input: ProvisionTenantInput): Promise<string> {
    if (input.inviterUserId) {
      const user = await this.prisma.user.findFirst({
        where: { id: input.inviterUserId, deletedAt: null },
        select: { id: true },
      });
      if (!user) {
        throw new NotFoundException(
          `inviterUserId ${input.inviterUserId} não encontrado`,
        );
      }
      return user.id;
    }

    if (!input.sourceOrgId) {
      throw new ConflictException(
        'Sem inviterUserId nem sourceOrgId: impossível resolver quem envia o convite. Passe --inviter <userId>.',
      );
    }

    const owner = await this.prisma.userOrganization.findFirst({
      where: { organizationId: input.sourceOrgId, role: OrgRole.OWNER },
      select: { userId: true },
      orderBy: { joinedAt: 'asc' },
    });
    if (!owner) {
      throw new NotFoundException(
        `Org-fonte ${input.sourceOrgId} não tem OWNER — passe --inviter <userId> explicitamente.`,
      );
    }
    return owner.userId;
  }

  // ─── Clonagem de agentes ────────────────────────────────────

  private async cloneAgents(
    input: ProvisionTenantInput,
    orgId: string | null,
    dryRun: boolean,
  ): Promise<ProvisionResult['agents']> {
    const empty: ProvisionResult['agents'] = {
      planned: 0,
      created: 0,
      skipped: 0,
      parentEdges: 0,
      details: [],
    };

    if (!input.sourceOrgId) {
      this.logger.log('Sem sourceOrgId — pulando clonagem de agentes');
      return empty;
    }

    const sourceExists = await this.prisma.organization.findFirst({
      where: { id: input.sourceOrgId, deletedAt: null },
      select: { id: true },
    });
    if (!sourceExists) {
      throw new NotFoundException(
        `sourceOrgId ${input.sourceOrgId} não encontrada`,
      );
    }

    const sourceAgents = await this.readSourceAgents(input.sourceOrgId);
    const planned: PlannedAgentCreate[] = planAgentClone(
      sourceAgents,
      input.agentFilter ?? {},
      { resetPipelineScope: input.resetPipelineScope ?? true },
    );

    // Idempotência: mapeia agentes-fonte já presentes no destino (por nome)
    // pra não duplicar e pra remapear pais que já existem lá.
    const idMap = new Map<string, string>();
    if (orgId) {
      const existing = await this.prisma.aiAgent.findMany({
        where: { organizationId: orgId, deletedAt: null },
        select: { id: true, name: true },
      });
      const existingByName = new Map(existing.map((e) => [e.name, e.id]));
      for (const plan of planned) {
        const match = existingByName.get(plan.data.name);
        if (match) idMap.set(plan.sourceId, match);
      }
    }

    const details: ProvisionAgentResult[] = [];
    let created = 0;
    let skipped = 0;

    const selectedById = new Map(sourceAgents.map((a) => [a.id, a]));

    for (const plan of planned) {
      const source = selectedById.get(plan.sourceId);
      const parentSourceId = source?.parentAgentId ?? null;

      if (idMap.has(plan.sourceId)) {
        skipped += 1;
        details.push({
          sourceId: plan.sourceId,
          newId: idMap.get(plan.sourceId) ?? null,
          name: plan.data.name,
          kind: plan.data.kind,
          parentSourceId,
          skippedReason: 'já existe no destino (mesmo nome)',
        });
        continue;
      }

      if (dryRun || !orgId) {
        details.push({
          sourceId: plan.sourceId,
          newId: null,
          name: plan.data.name,
          kind: plan.data.kind,
          parentSourceId,
        });
        continue;
      }

      const newId = await this.createClonedAgent(orgId, plan.data);
      idMap.set(plan.sourceId, newId);
      created += 1;
      details.push({
        sourceId: plan.sourceId,
        newId,
        name: plan.data.name,
        kind: plan.data.kind,
        parentSourceId,
      });
    }

    // Segundo passo: remapeia parentAgentId agora que os novos IDs existem.
    const clonedSources = planned
      .map((p) => selectedById.get(p.sourceId))
      .filter((a): a is CloneableAgent => a !== undefined);
    const parentUpdates = computeParentUpdates(clonedSources, idMap);

    if (!dryRun && orgId) {
      for (const upd of parentUpdates) {
        await this.prisma.aiAgent.update({
          where: { id: upd.id },
          data: { parentAgentId: upd.parentAgentId },
        });
      }
    }

    this.logger.log(
      `${dryRun ? '[DRY-RUN] ' : ''}Agentes: ${planned.length} planejados, ${created} criados, ${skipped} pulados, ${parentUpdates.length} arestas de hierarquia`,
    );

    return {
      planned: planned.length,
      created,
      skipped,
      parentEdges: parentUpdates.length,
      details,
    };
  }

  /** Lê os agentes vivos da org-fonte no shape que o planner consome. */
  private async readSourceAgents(sourceOrgId: string): Promise<CloneableAgent[]> {
    const rows = await this.prisma.aiAgent.findMany({
      where: { organizationId: sourceOrgId, deletedAt: null },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      avatarUrl: r.avatarUrl,
      kind: r.kind,
      category: r.category,
      capabilities: r.capabilities,
      parentAgentId: r.parentAgentId,
      department: r.department,
      squad: r.squad,
      modelId: r.modelId,
      modelParams: r.modelParams,
      systemPrompt: r.systemPrompt,
      operationalContext: r.operationalContext,
      operationalContextUpdatedAt: r.operationalContextUpdatedAt,
      temperature: r.temperature,
      maxTokens: r.maxTokens,
      canRespondDirectly: r.canRespondDirectly,
      isActive: r.isActive,
      followUpEnabled: r.followUpEnabled,
      followUpCadenceHours: r.followUpCadenceHours,
      pipelineScope: r.pipelineScope,
      mentionHandle: r.mentionHandle,
      rateLimitPerHour: r.rateLimitPerHour,
      consecutiveMsgCap: r.consecutiveMsgCap,
      humanizationEnabled: r.humanizationEnabled,
      minDelayMs: r.minDelayMs,
    }));
  }

  /** Persiste um clone (sem parentAgentId — aplicado no segundo passo). */
  private async createClonedAgent(
    organizationId: string,
    data: AgentCreateData,
  ): Promise<string> {
    const { modelParams, ...rest } = data;
    const created = await this.prisma.aiAgent.create({
      data: {
        organizationId,
        ...rest,
        modelParams:
          modelParams === null || modelParams === undefined
            ? undefined
            : (modelParams as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
    return created.id;
  }

  // ─── WhatsApp ───────────────────────────────────────────────

  private describeWhatsappStep(number: string | null): ProvisionResult['whatsapp'] {
    return {
      number,
      action: 'MANUAL_SETUP_REQUIRED',
      note: number
        ? `Criar canal Zappfy para ${number} pela UI/config da org nova — a criação de canal auto-registra o webhook. Este script NÃO provisiona instância Zappfy.`
        : 'Nenhum número informado — canal WhatsApp deve ser criado manualmente pela UI quando houver.',
    };
  }
}
