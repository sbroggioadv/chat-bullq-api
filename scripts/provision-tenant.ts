/**
 * provision-tenant.ts — Provisionamento de tenant isolado + clone de squad.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * O QUE FAZ
 *   1. Cria uma Organization NOVA e ISOLADA (+ department "Geral" default).
 *      A fronteira de multi-tenancy (todo dado é escopado por organizationId)
 *      garante que ela não enxerga dados de nenhuma outra org.
 *   2. Convida o admin via o fluxo de convite EXISTENTE
 *      (OrganizationsService.inviteMember → cria Invitation). O admin define a
 *      PRÓPRIA senha pelo link — o script NUNCA seta senha.
 *   3. Clona o squad de agentes de uma org-fonte (SOURCE_ORG_ID), filtrando
 *      por kind/department/squad, preservando a hierarquia orquestrador→workers
 *      (remapeia parentAgentId pros novos IDs).
 *   4. NÃO conecta WhatsApp real — só loga a instrução de criar o canal Zappfy
 *      pela UI (a criação de canal já auto-registra o webhook).
 *
 * IDEMPOTENTE: re-executar com os mesmos (nome, e-mail) reusa a org (marcador
 * em settings) e não duplica agentes (dedupe por nome).
 *
 * COMO RODAR (nunca contra produção sem CONFIRMO do Doc)
 *   DATABASE_URL="postgres://..." yarn ts-node -P tsconfig.json --transpile-only \
 *     scripts/provision-tenant.ts \
 *     --name "Marcela Advocacia" \
 *     --email marcela@sbroggio.com.br \
 *     --admin-name "Marcela" \
 *     --role OWNER \
 *     --whatsapp 5517988101808 \
 *     --source-org <SOURCE_ORG_ID> \
 *     --kinds ORCHESTRATOR \
 *     --departments JURIDICO \
 *     --dry-run
 *
 *   Tire o --dry-run pra executar de verdade. SEMPRE rode com --dry-run antes.
 *
 * ARGS (env como fallback; arg tem precedência)
 *   --name           TENANT_NAME        Nome da nova org (obrigatório)
 *   --email          ADMIN_EMAIL        E-mail do admin (obrigatório)
 *   --admin-name     ADMIN_NAME         Nome sugerido do admin (só log)
 *   --role           ADMIN_ROLE         OWNER | ADMIN (default OWNER)
 *   --whatsapp       WHATSAPP_NUMBER    E.164 sem + (só instrução, não conecta)
 *   --source-org     SOURCE_ORG_ID      Org de onde clonar os agentes
 *   --inviter        INVITER_USER_ID    User que envia o convite (default: OWNER da source-org)
 *   --kinds          AGENT_KINDS        Filtro: ORCHESTRATOR,WORKER (CSV)
 *   --departments    AGENT_DEPARTMENTS  Filtro: JURIDICO,VENDAS (CSV)
 *   --squads         AGENT_SQUADS       Filtro: "Squad Jurídico" (CSV)
 *   --keep-pipeline-scope               NÃO zera pipelineScope (default: zera)
 *   --dry-run                           Loga o plano sem escrever nada
 *   --help                              Mostra esta ajuda
 *
 * FILTRO (semântica de UNIÃO)
 *   Cada --kinds/--departments/--squads vira um seletor; o agente entra se
 *   casar com QUALQUER um. Ex.: `--kinds ORCHESTRATOR --departments JURIDICO`
 *   clona TODOS os orquestradores + TODOS do jurídico (a hierarquia fica
 *   íntegra porque os pais orquestradores entram junto). Sem filtro = clona
 *   todos os agentes vivos da org-fonte.
 *
 * PRESET MARCELA (advogada do escritório) — NÃO executar sem CONFIRMO do Doc
 *   --name "Marcela Advocacia" --email marcela@sbroggio.com.br
 *   --admin-name "Marcela" --role OWNER --whatsapp 5517988101808
 *   --source-org <ORG_DO_DOC> --kinds ORCHESTRATOR --departments JURIDICO
 *   Pendências antes de rodar: definir SOURCE_ORG_ID real (org do Doc) e o
 *   canal WhatsApp 5517988101808 é criado manualmente na UI depois.
 */

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AiAgentKind, OrgRole } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { OrganizationsRepository } from '../src/modules/organizations/organizations.repository';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';
import { TenantProvisioningService } from '../src/modules/provisioning/tenant-provisioning.service';
import {
  AgentSelector,
} from '../src/modules/provisioning/agent-clone.planner';
import { ProvisionTenantInput } from '../src/modules/provisioning/dto/provision-tenant.input';

const logger = new Logger('ProvisionTenant');

// ─── Parse de argumentos (sem dependência externa) ────────────

type ParsedArgs = {
  flags: Set<string>;
  values: Map<string, string>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const booleanFlags = new Set([
    'dry-run',
    'keep-pipeline-scope',
    'help',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      values.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      flags.add(key);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(key, next);
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return { flags, values };
}

function pick(
  args: ParsedArgs,
  argKey: string,
  envKey: string,
): string | undefined {
  return args.values.get(argKey) ?? process.env[envKey] ?? undefined;
}

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Monta os seletores de clone (união) a partir dos filtros. */
function buildSelectors(
  kinds: string[],
  departments: string[],
  squads: string[],
): AgentSelector[] {
  const selectors: AgentSelector[] = [];
  for (const k of kinds) {
    if (!(k in AiAgentKind)) {
      throw new Error(
        `kind inválido "${k}" — use ${Object.keys(AiAgentKind).join(' | ')}`,
      );
    }
    selectors.push({ kind: k as AiAgentKind });
  }
  for (const d of departments) selectors.push({ department: d });
  for (const s of squads) selectors.push({ squad: s });
  return selectors;
}

function parseRole(raw: string | undefined): OrgRole {
  if (!raw) return OrgRole.OWNER;
  const upper = raw.toUpperCase();
  if (!(upper in OrgRole)) {
    throw new Error(`role inválido "${raw}" — use ${Object.keys(OrgRole).join(' | ')}`);
  }
  if (upper === OrgRole.AGENT) {
    logger.warn('role=AGENT: admin com papel de agente (esperado OWNER/ADMIN)');
  }
  return upper as OrgRole;
}

const HELP = `Uso: DATABASE_URL=... yarn ts-node -P tsconfig.json --transpile-only \\
  scripts/provision-tenant.ts --name "..." --email "..." [opções]

Rode com --help pra ver o cabeçalho do arquivo com todos os args e o preset Marcela.
Args principais: --name --email --admin-name --role --whatsapp --source-org
  --inviter --kinds --departments --squads --keep-pipeline-scope --dry-run`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('help')) {
    logger.log(HELP);
    return;
  }

  const tenantName = pick(args, 'name', 'TENANT_NAME');
  const adminEmail = pick(args, 'email', 'ADMIN_EMAIL');

  if (!tenantName || !adminEmail) {
    logger.error('Faltam obrigatórios: --name/TENANT_NAME e --email/ADMIN_EMAIL');
    logger.log(HELP);
    process.exitCode = 1;
    return;
  }

  const dryRun = args.flags.has('dry-run');
  const input: ProvisionTenantInput = {
    tenantName,
    adminEmail,
    adminName: pick(args, 'admin-name', 'ADMIN_NAME'),
    adminRole: parseRole(pick(args, 'role', 'ADMIN_ROLE')),
    whatsappNumber: pick(args, 'whatsapp', 'WHATSAPP_NUMBER'),
    inviterUserId: pick(args, 'inviter', 'INVITER_USER_ID'),
    sourceOrgId: pick(args, 'source-org', 'SOURCE_ORG_ID'),
    agentFilter: {
      selectors: buildSelectors(
        csv(pick(args, 'kinds', 'AGENT_KINDS')),
        csv(pick(args, 'departments', 'AGENT_DEPARTMENTS')),
        csv(pick(args, 'squads', 'AGENT_SQUADS')),
      ),
    },
    resetPipelineScope: !args.flags.has('keep-pipeline-scope'),
  };

  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL ausente no ambiente — abortando.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    const orgRepo = new OrganizationsRepository(prisma);
    const orgService = new OrganizationsService(orgRepo);
    const provisioning = new TenantProvisioningService(prisma, orgService);

    const result = await provisioning.provision(input, { dryRun });

    logger.log(
      `${dryRun ? '[DRY-RUN] ' : ''}Resultado:\n${JSON.stringify(result, null, 2)}`,
    );

    if (!dryRun && result.invitation.status === 'CREATED' && result.invitation.token) {
      logger.log(
        `Link de aceite (admin define a senha): registrar com inviteToken=${result.invitation.token} (email=${result.invitation.email})`,
      );
    }
  } catch (err) {
    logger.error(
      `Falha no provisionamento: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
    process.exitCode = 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main();
