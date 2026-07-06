import { AiAgentKind, OrgRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { TenantProvisioningService } from './tenant-provisioning.service';

// ─── Helpers ──────────────────────────────────────────────────

interface SourceRow {
  id: string;
  name: string;
  kind: AiAgentKind;
  parentAgentId: string | null;
  department: string | null;
  squad: string | null;
  isActive: boolean;
}

function row(partial: Partial<SourceRow> & { id: string; name: string }): Record<string, unknown> {
  return {
    id: partial.id,
    name: partial.name,
    description: null,
    avatarUrl: null,
    kind: partial.kind ?? AiAgentKind.WORKER,
    category: null,
    capabilities: [],
    parentAgentId: partial.parentAgentId ?? null,
    department: partial.department ?? null,
    squad: partial.squad ?? null,
    modelId: 'zai/glm-5.2',
    modelParams: null,
    systemPrompt: 'prompt',
    operationalContext: null,
    operationalContextUpdatedAt: null,
    temperature: 0.7,
    maxTokens: 2048,
    canRespondDirectly: true,
    isActive: partial.isActive ?? true,
    followUpEnabled: true,
    followUpCadenceHours: [4, 24],
    pipelineScope: [],
    mentionHandle: null,
    rateLimitPerHour: 60,
    consecutiveMsgCap: 5,
    humanizationEnabled: true,
    minDelayMs: 15000,
  };
}

interface Mocks {
  service: TenantProvisioningService;
  createCalls: Array<{ name: string; id: string; parentAgentId: unknown }>;
  updateCalls: Array<{ id: string; parentAgentId: string }>;
  inviteMember: jest.Mock;
}

function buildMocks(sourceRows: Array<Record<string, unknown>>, existingTarget: Array<Record<string, unknown>> = []): Mocks {
  const createCalls: Mocks['createCalls'] = [];
  const updateCalls: Mocks['updateCalls'] = [];
  let seq = 0;

  const prismaMock = {
    organization: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // Lookup da org-fonte (só tem where.id). A busca de idempotência usa
        // name + AND[via, for] e deve retornar null (org ainda não existe).
        if (where.id === 'source-org') return { id: 'source-org' };
        return null;
      }),
    },
    department: { create: jest.fn(async () => ({ id: 'dept' })) },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        organization: {
          create: jest.fn(async () => ({ id: 'new-org', slug: 'new-org-abc' })),
        },
        department: { create: jest.fn(async () => ({ id: 'dept' })) },
      };
      return cb(tx);
    }),
    aiAgent: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.organizationId === 'source-org') return sourceRows;
        return existingTarget; // target org existing agents
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const id = `new-${seq}`;
        createCalls.push({
          name: data.name as string,
          id,
          parentAgentId: data.parentAgentId,
        });
        return { id };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { parentAgentId: string } }) => {
        updateCalls.push({ id: where.id, parentAgentId: data.parentAgentId });
        return { id: where.id };
      }),
    },
    user: {
      findFirst: jest.fn(async () => ({ id: 'inviter-user' })),
    },
    userOrganization: {
      findFirst: jest.fn(async () => ({ userId: 'inviter-user' })),
    },
  };

  const inviteMember = jest.fn(async () => ({ token: 'invite-token', autoAccepted: false }));
  const orgServiceMock = { inviteMember };

  const service = new TenantProvisioningService(
    prismaMock as unknown as PrismaService,
    orgServiceMock as unknown as OrganizationsService,
  );

  return { service, createCalls, updateCalls, inviteMember };
}

// ─── Testes ───────────────────────────────────────────────────

describe('TenantProvisioningService (clone + remap com Prisma mockado)', () => {
  const sourceRows = [
    row({ id: 'orq', name: 'Orquestrador', kind: AiAgentKind.ORCHESTRATOR, parentAgentId: null }),
    row({ id: 'w1', name: 'Worker A', kind: AiAgentKind.WORKER, parentAgentId: 'orq' }),
    row({ id: 'w2', name: 'Worker B', kind: AiAgentKind.WORKER, parentAgentId: 'orq' }),
  ];

  it('cria org, clona 3 agentes e remapeia parentAgentId pros novos IDs', async () => {
    const { service, createCalls, updateCalls, inviteMember } = buildMocks(sourceRows);

    const result = await service.provision(
      {
        tenantName: 'Acme Advocacia',
        adminEmail: 'admin@example.com',
        adminRole: OrgRole.OWNER,
        inviterUserId: 'inviter-user',
        sourceOrgId: 'source-org',
      },
      { dryRun: false },
    );

    // Cópia: 3 agentes criados, orquestrador primeiro.
    expect(createCalls).toHaveLength(3);
    expect(createCalls[0].name).toBe('Orquestrador');
    // Nenhum create carrega parentAgentId (aplicado no 2º passo).
    expect(createCalls.every((c) => c.parentAgentId === undefined)).toBe(true);

    // Remap: 2 updates, ambos apontando pro novo ID do orquestrador.
    const orqNewId = createCalls.find((c) => c.name === 'Orquestrador')!.id;
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls.every((u) => u.parentAgentId === orqNewId)).toBe(true);

    expect(result.agents.created).toBe(3);
    expect(result.agents.parentEdges).toBe(2);
    expect(result.organization.id).toBe('new-org');
    expect(result.organization.reused).toBe(false);
    expect(inviteMember).toHaveBeenCalledTimes(1);
    expect(result.invitation.status).toBe('CREATED');
    expect(result.invitation.token).toBe('invite-token');
    // WhatsApp nunca é provisionado.
    expect(result.whatsapp.action).toBe('MANUAL_SETUP_REQUIRED');
  });

  it('dry-run não escreve nada (zero create/update) mas planeja tudo', async () => {
    const { service, createCalls, updateCalls, inviteMember } = buildMocks(sourceRows);

    const result = await service.provision(
      {
        tenantName: 'Acme Advocacia',
        adminEmail: 'admin@example.com',
        inviterUserId: 'inviter-user',
        sourceOrgId: 'source-org',
      },
      { dryRun: true },
    );

    expect(createCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(inviteMember).not.toHaveBeenCalled();
    expect(result.agents.planned).toBe(3);
    expect(result.agents.created).toBe(0);
    expect(result.invitation.status).toBe('DRY_RUN');
  });

  it('idempotência: agente já existente no destino (mesmo nome) é pulado', async () => {
    const { service, createCalls } = buildMocks(sourceRows, [
      { id: 'existing-orq', name: 'Orquestrador' },
    ]);

    const result = await service.provision(
      {
        tenantName: 'Acme Advocacia',
        adminEmail: 'admin@example.com',
        inviterUserId: 'inviter-user',
        sourceOrgId: 'source-org',
      },
      { dryRun: false },
    );

    // Orquestrador não recriado; só os 2 workers.
    expect(createCalls.map((c) => c.name).sort()).toEqual(['Worker A', 'Worker B']);
    expect(result.agents.created).toBe(2);
    expect(result.agents.skipped).toBe(1);
    // Workers ainda remapeiam pro orquestrador PRÉ-EXISTENTE.
    expect(result.agents.parentEdges).toBe(2);
  });

  it('filtro por kind ORCHESTRATOR clona só o orquestrador', async () => {
    const { service, createCalls } = buildMocks(sourceRows);

    const result = await service.provision(
      {
        tenantName: 'Acme Advocacia',
        adminEmail: 'admin@example.com',
        inviterUserId: 'inviter-user',
        sourceOrgId: 'source-org',
        agentFilter: { selectors: [{ kind: AiAgentKind.ORCHESTRATOR }] },
      },
      { dryRun: false },
    );

    expect(createCalls.map((c) => c.name)).toEqual(['Orquestrador']);
    expect(result.agents.created).toBe(1);
    expect(result.agents.parentEdges).toBe(0);
  });
});
