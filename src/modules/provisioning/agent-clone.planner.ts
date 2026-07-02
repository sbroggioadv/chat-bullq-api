import { AiAgentKind } from '@prisma/client';

/**
 * Planner PURO (sem I/O, sem Prisma) para clonagem de um squad de agentes
 * entre organizações. Toda a lógica de decisão vive aqui pra ser testável
 * sem banco: filtro, cópia de campos e remapeamento de hierarquia
 * (parentAgentId) são funções puras.
 *
 * A camada de persistência (TenantProvisioningService) só executa o plano.
 */

// ─── Contratos ────────────────────────────────────────────────

/**
 * Shape mínimo de um `AiAgent` da org-fonte que o planner precisa ler.
 * Espelha os campos clonáveis do model `AiAgent` (schema.prisma) — os
 * campos NÃO clonáveis (id/organizationId/timestamps) ficam de fora do
 * output, mas `id`/`parentAgentId` entram no input pra remapear a árvore.
 */
export interface CloneableAgent {
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  kind: AiAgentKind;
  category: string | null;
  capabilities: string[];
  parentAgentId: string | null;
  department: string | null;
  squad: string | null;
  modelId: string;
  modelParams: unknown;
  systemPrompt: string;
  operationalContext: string | null;
  operationalContextUpdatedAt: Date | null;
  temperature: number;
  maxTokens: number;
  canRespondDirectly: boolean;
  isActive: boolean;
  followUpEnabled: boolean;
  followUpCadenceHours: number[];
  // ─── S22 — Scope & Cadence ───
  pipelineScope: string[];
  mentionHandle: string | null;
  rateLimitPerHour: number;
  consecutiveMsgCap: number;
  humanizationEnabled: boolean;
  minDelayMs: number;
}

/**
 * Um seletor casa um agente por qualquer combinação de kind/department/squad
 * (AND entre os campos definidos). Campos ausentes são curinga.
 */
export interface AgentSelector {
  kind?: AiAgentKind;
  department?: string;
  squad?: string;
}

export interface AgentCloneFilter {
  /**
   * Lista de seletores em OR: o agente entra no clone se casar com PELO
   * MENOS UM seletor. Vazio/ausente = clona todos os agentes elegíveis.
   *
   * Ex.: `[{ kind: 'ORCHESTRATOR' }, { department: 'JURIDICO' }]`
   * clona todos os orquestradores + todos do jurídico (preservando a
   * hierarquia, já que os pais orquestradores também entram).
   */
  selectors?: AgentSelector[];
  /** Inclui agentes com isActive=false. Default false. */
  includeInactive?: boolean;
}

export interface AgentCloneOptions {
  /**
   * pipelineScope guarda IDs de pipelines da ORG-FONTE — que não existem
   * na org nova. Copiar geraria refs órfãs (ignoradas em runtime, mas
   * ruído). Default true: zera o escopo (agente vira fallback genérico
   * até o admin da nova org reconfigurar). Aquecia pode desligar quando
   * implementar remapeamento de pipelines.
   */
  resetPipelineScope?: boolean;
}

/**
 * Dados prontos pra `prisma.aiAgent.create({ data: { organizationId, ...data } })`.
 * NÃO inclui parentAgentId — a hierarquia é aplicada num segundo passo
 * (computeParentUpdates) depois que os novos IDs existem.
 */
export interface AgentCreateData {
  name: string;
  description: string | null;
  avatarUrl: string | null;
  kind: AiAgentKind;
  category: string | null;
  capabilities: string[];
  department: string | null;
  squad: string | null;
  modelId: string;
  modelParams: unknown;
  systemPrompt: string;
  operationalContext: string | null;
  operationalContextUpdatedAt: Date | null;
  temperature: number;
  maxTokens: number;
  canRespondDirectly: boolean;
  isActive: boolean;
  followUpEnabled: boolean;
  followUpCadenceHours: number[];
  pipelineScope: string[];
  mentionHandle: string | null;
  rateLimitPerHour: number;
  consecutiveMsgCap: number;
  humanizationEnabled: boolean;
  minDelayMs: number;
}

export interface PlannedAgentCreate {
  /** ID do agente na org-fonte (chave pra remapear a hierarquia depois). */
  sourceId: string;
  data: AgentCreateData;
}

/** Atualização de hierarquia: aplica parentAgentId após criar os clones. */
export interface ParentUpdate {
  /** ID do NOVO agente (na org de destino). */
  id: string;
  /** ID do NOVO pai (na org de destino). */
  parentAgentId: string;
}

// ─── Filtro ───────────────────────────────────────────────────

function selectorMatches(agent: CloneableAgent, sel: AgentSelector): boolean {
  if (sel.kind !== undefined && agent.kind !== sel.kind) return false;
  if (
    sel.department !== undefined &&
    (agent.department ?? '').toLowerCase() !== sel.department.toLowerCase()
  ) {
    return false;
  }
  if (
    sel.squad !== undefined &&
    (agent.squad ?? '').toLowerCase() !== sel.squad.toLowerCase()
  ) {
    return false;
  }
  return true;
}

/**
 * Filtra os agentes elegíveis pra clonagem. Um agente entra se casar com
 * pelo menos um seletor (OR). Sem seletores = todos. Respeita includeInactive.
 */
export function filterAgentsForClone(
  agents: CloneableAgent[],
  filter: AgentCloneFilter = {},
): CloneableAgent[] {
  const { selectors, includeInactive = false } = filter;
  return agents.filter((a) => {
    if (!includeInactive && !a.isActive) return false;
    if (!selectors || selectors.length === 0) return true;
    return selectors.some((sel) => selectorMatches(a, sel));
  });
}

// ─── Cópia de campos ──────────────────────────────────────────

/**
 * Mapeia um agente-fonte pro payload de criação na org nova. Copia todos
 * os campos de comportamento (kind, prompt, squad, config S22, cadência,
 * humanização) e deixa de fora o que é identidade/relacional (id,
 * organizationId, parentAgentId, timestamps de auditoria).
 */
export function buildAgentCreateData(
  source: CloneableAgent,
  opts: AgentCloneOptions = {},
): AgentCreateData {
  const { resetPipelineScope = true } = opts;
  return {
    name: source.name,
    description: source.description,
    avatarUrl: source.avatarUrl,
    kind: source.kind,
    category: source.category,
    capabilities: [...source.capabilities],
    department: source.department,
    squad: source.squad,
    modelId: source.modelId,
    modelParams: source.modelParams,
    systemPrompt: source.systemPrompt,
    operationalContext: source.operationalContext,
    operationalContextUpdatedAt: source.operationalContextUpdatedAt,
    temperature: source.temperature,
    maxTokens: source.maxTokens,
    canRespondDirectly: source.canRespondDirectly,
    isActive: source.isActive,
    followUpEnabled: source.followUpEnabled,
    followUpCadenceHours: [...source.followUpCadenceHours],
    // S22 scope & cadence — pipelineScope é org-scoped: zera por padrão.
    pipelineScope: resetPipelineScope ? [] : [...source.pipelineScope],
    // mentionHandle é único por (org, handle). Como a org é nova, não há
    // colisão — preserva o handle original.
    mentionHandle: source.mentionHandle,
    rateLimitPerHour: source.rateLimitPerHour,
    consecutiveMsgCap: source.consecutiveMsgCap,
    humanizationEnabled: source.humanizationEnabled,
    minDelayMs: source.minDelayMs,
  };
}

// ─── Plano completo ───────────────────────────────────────────

/**
 * Monta o plano de criação (sem hierarquia ainda) pro conjunto filtrado.
 * A ordem preserva orquestradores antes de workers, por clareza de log —
 * mas a hierarquia real é aplicada num segundo passo (computeParentUpdates),
 * então a ordem de criação não afeta a corretude.
 */
export function planAgentClone(
  agents: CloneableAgent[],
  filter: AgentCloneFilter = {},
  opts: AgentCloneOptions = {},
): PlannedAgentCreate[] {
  const selected = filterAgentsForClone(agents, filter);
  // Orquestradores primeiro (raízes de árvore) só pra log/legibilidade.
  const ordered = [...selected].sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === AiAgentKind.ORCHESTRATOR ? -1 : 1;
  });
  return ordered.map((source) => ({
    sourceId: source.id,
    data: buildAgentCreateData(source, opts),
  }));
}

// ─── Remapeamento de hierarquia (segundo passo) ───────────────

/**
 * Dado o conjunto de agentes CLONADOS e o mapa sourceId→newId, calcula as
 * atualizações de parentAgentId na org de destino.
 *
 * Regras:
 * - Só remapeia se o pai TAMBÉM foi clonado (está no idMap). Se o pai foi
 *   filtrado pra fora, o filho vira raiz (nenhuma atualização → fica null).
 * - Preserva profundidade arbitrária (orquestrador→orquestrador→worker):
 *   cada aresta é resolvida independentemente pelo mapa.
 * - Ignora auto-referência defensivamente (não deveria existir no schema).
 */
export function computeParentUpdates(
  clonedSourceAgents: Pick<CloneableAgent, 'id' | 'parentAgentId'>[],
  idMap: Map<string, string>,
): ParentUpdate[] {
  const updates: ParentUpdate[] = [];
  for (const agent of clonedSourceAgents) {
    const parentSourceId = agent.parentAgentId;
    if (!parentSourceId) continue; // raiz na fonte → raiz no destino
    if (parentSourceId === agent.id) continue; // auto-ref defensivo
    const newId = idMap.get(agent.id);
    const newParentId = idMap.get(parentSourceId);
    // Pai não clonado (filtrado pra fora) → filho fica raiz no destino.
    if (!newId || !newParentId) continue;
    updates.push({ id: newId, parentAgentId: newParentId });
  }
  return updates;
}
