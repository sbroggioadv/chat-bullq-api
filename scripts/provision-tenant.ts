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
 *   Dados reais entram SÓ via args na execução — NUNCA versionados aqui.
 *   DATABASE_URL="postgres://..." yarn ts-node -P tsconfig.json --transpile-only \
 *     scripts/provision-tenant.ts \
 *     --name "Acme Advocacia" \
 *     --email admin@example.com \
 *     --admin-name "Admin" \
 *     --role OWNER \
 *     --whatsapp 5511999999999 \
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
 * PRESET "advogada isolada" — onboarding de um usuário com org própria.
 *   Placeholders fictícios (dados reais entram por args na execução):
 *   --name "Acme Advocacia" --email admin@example.com
 *   --admin-name "Admin" --role OWNER --whatsapp 5511999999999
 *   --source-org <ORG_FONTE> --kinds ORCHESTRATOR --departments JURIDICO
 *   Pendências antes de rodar: definir SOURCE_ORG_ID real (org-fonte) e o
 *   canal WhatsApp é criado manualmente na UI depois do provisionamento.
 */

import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { AiAgentKind, OrgRole } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { OrganizationsRepository } from '../src/modules/organizations/organizations.repository';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';
import { TenantProvisioningService } from '../src/modules/provisioning/tenant-provisioning.service';
import {
  AgentSelector,
} from '../src/modules/provisioning/agent-clone.planner';
import {
  ProvisionResult,
  ProvisionTenantInput,
} from '../src/modules/provisioning/dto/provision-tenant.input';
import { maskEmail, maskPhone } from '../src/modules/provisioning/pii-mask.util';

const logger = new Logger('ProvisionTenant');

// ─── Parse de argumentos (sem dependência externa) ────────────

export type ParsedArgs = {
  flags: Set<string>;
  values: Map<string, string>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const booleanFlags = new Set([
    'dry-run',
    'keep-pipeline-scope',
    'help',
  ]);

  // Trata `--flag=true`/`--flag=false` como booleano (senão `--dry-run=true`
  // cairia no ramo de valores e o dry-run NUNCA seria aplicado → escreveria
  // no banco de verdade). "" / true / 1 / yes = ligado; false / 0 / no = desligado.
  const truthy = (v: string): boolean =>
    v === '' || /^(true|1|yes)$/i.test(v);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      const key = token.slice(2, eq);
      const val = token.slice(eq + 1);
      if (booleanFlags.has(key)) {
        if (truthy(val)) flags.add(key);
        continue;
      }
      values.set(key, val);
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

Rode com --help pra ver o cabeçalho do arquivo com todos os args e o preset de exemplo.
Args principais: --name --email --admin-name --role --whatsapp --source-org
  --inviter --kinds --departments --squads --keep-pipeline-scope --dry-run`;

/**
 * Redige o resultado pra log: nunca despeja token/e-mail/telefone crus.
 * O token de convite é credencial (permite definir a senha do admin) e não
 * pode ir pro stdout/arquivo de log.
 */
function redactResult(result: ProvisionResult): ProvisionResult {
  return {
    ...result,
    invitation: {
      ...result.invitation,
      email: maskEmail(result.invitation.email),
      token: result.invitation.token ? '[gravado em arquivo seguro]' : null,
    },
    whatsapp: {
      ...result.whatsapp,
      number: result.whatsapp.number ? maskPhone(result.whatsapp.number) : null,
    },
  };
}

/** Grava o token de convite num arquivo 0600 (só o dono lê). Retorna o path. */
function writeInviteTokenFile(email: string, token: string): string {
  const file = path.join(os.tmpdir(), `provision-invite-${Date.now()}.txt`);
  const body = [
    '# Token de convite — CREDENCIAL (permite definir a senha do admin).',
    '# Entregue por canal seguro e apague o arquivo após o uso.',
    `email=${email}`,
    `inviteToken=${token}`,
    '',
  ].join('\n');
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

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

  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL ausente no ambiente — abortando.');
    process.exitCode = 1;
    return;
  }

  const dryRun = args.flags.has('dry-run');

  // prisma declarado fora do try só pra o finally poder desconectar; a
  // instanciação/conexão e o parse que pode lançar (parseRole/buildSelectors)
  // ficam DENTRO do try pra não virar unhandled rejection.
  let prisma: PrismaService | null = null;
  try {
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

    prisma = new PrismaService();
    await prisma.onModuleInit();

    const orgService = new OrganizationsService(
      new OrganizationsRepository(prisma),
    );
    const provisioning = new TenantProvisioningService(prisma, orgService);

    const result = await provisioning.provision(input, { dryRun });

    logger.log(
      `${dryRun ? '[DRY-RUN] ' : ''}Resultado:\n${JSON.stringify(redactResult(result), null, 2)}`,
    );

    if (
      !dryRun &&
      result.invitation.status === 'CREATED' &&
      result.invitation.token
    ) {
      const file = writeInviteTokenFile(
        result.invitation.email,
        result.invitation.token,
      );
      logger.log(
        `Convite criado para ${maskEmail(result.invitation.email)}. Token gravado (0600) em: ${file} — entregue por canal seguro e apague após o uso.`,
      );
    }
  } catch (err) {
    logger.error(
      `Falha no provisionamento: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.onModuleDestroy();
  }
}

// Só executa quando rodado direto (não quando importado por um teste).
if (require.main === module) {
  void main();
}
