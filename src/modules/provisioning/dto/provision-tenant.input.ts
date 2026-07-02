import { OrgRole } from '@prisma/client';
import { AgentCloneFilter } from '../agent-clone.planner';

/**
 * Contrato de entrada do provisionamento de tenant. Tool-agnostic: serve
 * tanto ao script CLI (`scripts/provision-tenant.ts`) quanto a um futuro
 * endpoint self-service/admin do Aquecia.
 */
export interface ProvisionTenantInput {
  /** Nome da nova organização (tenant). Ex.: "Acme Advocacia". */
  tenantName: string;

  /** E-mail do admin que receberá o convite. Ele define a própria senha. */
  adminEmail: string;

  /**
   * Nome do admin — usado só para log/preenchimento sugerido. O nome real
   * é definido pelo próprio usuário ao aceitar o convite (register).
   */
  adminName?: string;

  /** Papel do admin na nova org. Default OWNER. */
  adminRole?: OrgRole;

  /**
   * WhatsApp do tenant (E.164 sem +, ex.: 5511999999999). NÃO provisiona
   * canal — apenas registra na instrução final de próximos passos.
   */
  whatsappNumber?: string;

  /**
   * Usuário existente que "envia" o convite (FK Invitation.invitedById).
   * Se ausente, o service resolve para o OWNER da `sourceOrgId`.
   */
  inviterUserId?: string;

  /** Org de onde clonar o squad de agentes. Ausente = não clona agentes. */
  sourceOrgId?: string;

  /** Filtro de clonagem (seletores por kind/department/squad). */
  agentFilter?: AgentCloneFilter;

  /**
   * Zera pipelineScope dos agentes clonados (IDs de pipeline não cruzam
   * org). Default true.
   */
  resetPipelineScope?: boolean;
}

export interface ProvisionAgentResult {
  sourceId: string;
  newId: string | null; // null em dry-run ou quando pulado por idempotência
  name: string;
  kind: string;
  parentSourceId: string | null;
  skippedReason?: string;
}

export interface ProvisionResult {
  dryRun: boolean;
  organization: {
    id: string | null; // null em dry-run quando ainda não existe
    name: string;
    slug: string | null;
    reused: boolean;
  };
  invitation: {
    email: string;
    role: OrgRole;
    status: 'CREATED' | 'ALREADY_MEMBER' | 'AUTO_ACCEPTED' | 'DRY_RUN';
    token: string | null; // link de aceite; null em dry-run/auto-accept
  };
  agents: {
    planned: number;
    created: number;
    skipped: number;
    parentEdges: number;
    details: ProvisionAgentResult[];
  };
  whatsapp: {
    number: string | null;
    action: 'MANUAL_SETUP_REQUIRED';
    note: string;
  };
}
