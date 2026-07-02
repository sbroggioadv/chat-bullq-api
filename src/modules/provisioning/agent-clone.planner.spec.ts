import { AiAgentKind } from '@prisma/client';
import {
  buildAgentCreateData,
  CloneableAgent,
  computeParentUpdates,
  filterAgentsForClone,
  planAgentClone,
} from './agent-clone.planner';

// ─── Fixture ──────────────────────────────────────────────────

function makeAgent(overrides: Partial<CloneableAgent>): CloneableAgent {
  return {
    id: 'src-1',
    name: 'Agente',
    description: null,
    avatarUrl: null,
    kind: AiAgentKind.WORKER,
    category: null,
    capabilities: [],
    parentAgentId: null,
    department: null,
    squad: null,
    modelId: 'anthropic/claude-sonnet-4-6',
    modelParams: null,
    systemPrompt: 'prompt',
    operationalContext: null,
    operationalContextUpdatedAt: null,
    temperature: 0.7,
    maxTokens: 2048,
    canRespondDirectly: true,
    isActive: true,
    followUpEnabled: true,
    followUpCadenceHours: [4, 24, 72],
    pipelineScope: [],
    mentionHandle: null,
    rateLimitPerHour: 60,
    consecutiveMsgCap: 5,
    humanizationEnabled: true,
    minDelayMs: 15000,
    ...overrides,
  };
}

describe('buildAgentCreateData', () => {
  it('copia todos os campos de comportamento e omite identidade/relacional', () => {
    const source = makeAgent({
      id: 'src-x',
      name: 'Orq Jurídico',
      kind: AiAgentKind.ORCHESTRATOR,
      department: 'JURIDICO',
      squad: 'Squad Jurídico',
      capabilities: ['triagem', 'peticao'],
      systemPrompt: 'Você é o orquestrador jurídico',
      operationalContext: 'Contexto vivo',
      operationalContextUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      temperature: 0.3,
      maxTokens: 4096,
      modelParams: { top_p: 0.9 },
      mentionHandle: 'juridico',
      rateLimitPerHour: 30,
      consecutiveMsgCap: 3,
      humanizationEnabled: false,
      minDelayMs: 5000,
      followUpCadenceHours: [1, 2, 3],
    });

    const data = buildAgentCreateData(source);

    expect(data).toMatchObject({
      name: 'Orq Jurídico',
      kind: AiAgentKind.ORCHESTRATOR,
      department: 'JURIDICO',
      squad: 'Squad Jurídico',
      capabilities: ['triagem', 'peticao'],
      systemPrompt: 'Você é o orquestrador jurídico',
      operationalContext: 'Contexto vivo',
      temperature: 0.3,
      maxTokens: 4096,
      modelParams: { top_p: 0.9 },
      mentionHandle: 'juridico',
      rateLimitPerHour: 30,
      consecutiveMsgCap: 3,
      humanizationEnabled: false,
      minDelayMs: 5000,
      followUpCadenceHours: [1, 2, 3],
    });
    // NÃO deve carregar id/organizationId/parentAgentId no payload de create.
    expect(data).not.toHaveProperty('id');
    expect(data).not.toHaveProperty('organizationId');
    expect(data).not.toHaveProperty('parentAgentId');
  });

  it('zera pipelineScope por padrão (IDs de pipeline não cruzam org)', () => {
    const source = makeAgent({ pipelineScope: ['pipe-a', 'pipe-b'] });
    expect(buildAgentCreateData(source).pipelineScope).toEqual([]);
  });

  it('preserva pipelineScope quando resetPipelineScope=false', () => {
    const source = makeAgent({ pipelineScope: ['pipe-a', 'pipe-b'] });
    const data = buildAgentCreateData(source, { resetPipelineScope: false });
    expect(data.pipelineScope).toEqual(['pipe-a', 'pipe-b']);
  });

  it('copia arrays por valor (não compartilha referência com a fonte)', () => {
    const source = makeAgent({ capabilities: ['a'], followUpCadenceHours: [4] });
    const data = buildAgentCreateData(source);
    expect(data.capabilities).not.toBe(source.capabilities);
    expect(data.followUpCadenceHours).not.toBe(source.followUpCadenceHours);
    data.capabilities.push('b');
    expect(source.capabilities).toEqual(['a']);
  });
});

describe('filterAgentsForClone', () => {
  const orq = makeAgent({ id: 'orq', kind: AiAgentKind.ORCHESTRATOR, department: 'OPERACOES' });
  const jur = makeAgent({ id: 'jur', kind: AiAgentKind.WORKER, department: 'JURIDICO' });
  const vendas = makeAgent({ id: 'vnd', kind: AiAgentKind.WORKER, department: 'VENDAS' });
  const inativo = makeAgent({ id: 'off', kind: AiAgentKind.WORKER, department: 'JURIDICO', isActive: false });
  const all = [orq, jur, vendas, inativo];

  it('sem seletores retorna todos os ativos e exclui inativos', () => {
    const result = filterAgentsForClone(all);
    expect(result.map((a) => a.id).sort()).toEqual(['jur', 'orq', 'vnd']);
  });

  it('includeInactive inclui os isActive=false', () => {
    const result = filterAgentsForClone(all, { includeInactive: true });
    expect(result.map((a) => a.id).sort()).toEqual(['jur', 'off', 'orq', 'vnd']);
  });

  it('seletor por kind ORCHESTRATOR', () => {
    const result = filterAgentsForClone(all, { selectors: [{ kind: AiAgentKind.ORCHESTRATOR }] });
    expect(result.map((a) => a.id)).toEqual(['orq']);
  });

  it('união: ORCHESTRATOR (qualquer dept) + JURIDICO (qualquer kind)', () => {
    const result = filterAgentsForClone(all, {
      selectors: [{ kind: AiAgentKind.ORCHESTRATOR }, { department: 'JURIDICO' }],
    });
    expect(result.map((a) => a.id).sort()).toEqual(['jur', 'orq']);
  });

  it('match de department é case-insensitive', () => {
    const result = filterAgentsForClone(all, { selectors: [{ department: 'juridico' }] });
    expect(result.map((a) => a.id)).toEqual(['jur']);
  });

  it('seletor por squad case-insensitive', () => {
    const withSquad = makeAgent({ id: 'sq', squad: 'Squad Jurídico' });
    const result = filterAgentsForClone([withSquad, vendas], {
      selectors: [{ squad: 'squad jurídico' }],
    });
    expect(result.map((a) => a.id)).toEqual(['sq']);
  });
});

describe('computeParentUpdates', () => {
  it('remapeia workers para o novo orquestrador; raiz não recebe update', () => {
    const orq = makeAgent({ id: 'orq', kind: AiAgentKind.ORCHESTRATOR, parentAgentId: null });
    const w1 = makeAgent({ id: 'w1', parentAgentId: 'orq' });
    const w2 = makeAgent({ id: 'w2', parentAgentId: 'orq' });
    const idMap = new Map([
      ['orq', 'new-orq'],
      ['w1', 'new-w1'],
      ['w2', 'new-w2'],
    ]);

    const updates = computeParentUpdates([orq, w1, w2], idMap);

    expect(updates).toEqual(
      expect.arrayContaining([
        { id: 'new-w1', parentAgentId: 'new-orq' },
        { id: 'new-w2', parentAgentId: 'new-orq' },
      ]),
    );
    // Orquestrador é raiz → sem update.
    expect(updates).toHaveLength(2);
    expect(updates.find((u) => u.id === 'new-orq')).toBeUndefined();
  });

  it('preserva hierarquia multi-nível (orq → sub-orq → worker)', () => {
    const orq = makeAgent({ id: 'orq', kind: AiAgentKind.ORCHESTRATOR, parentAgentId: null });
    const sub = makeAgent({ id: 'sub', kind: AiAgentKind.ORCHESTRATOR, parentAgentId: 'orq' });
    const w = makeAgent({ id: 'w', parentAgentId: 'sub' });
    const idMap = new Map([
      ['orq', 'n-orq'],
      ['sub', 'n-sub'],
      ['w', 'n-w'],
    ]);

    const updates = computeParentUpdates([orq, sub, w], idMap);

    expect(updates).toEqual(
      expect.arrayContaining([
        { id: 'n-sub', parentAgentId: 'n-orq' },
        { id: 'n-w', parentAgentId: 'n-sub' },
      ]),
    );
    expect(updates).toHaveLength(2);
  });

  it('pai filtrado pra fora → filho vira raiz (sem update)', () => {
    const w = makeAgent({ id: 'w', parentAgentId: 'orq-nao-clonado' });
    const idMap = new Map([['w', 'new-w']]); // pai ausente do mapa
    expect(computeParentUpdates([w], idMap)).toEqual([]);
  });

  it('ignora auto-referência defensivamente', () => {
    const self = makeAgent({ id: 'x', parentAgentId: 'x' });
    const idMap = new Map([['x', 'new-x']]);
    expect(computeParentUpdates([self], idMap)).toEqual([]);
  });

  it('não gera update quando o próprio filho não está no idMap', () => {
    const w = makeAgent({ id: 'w', parentAgentId: 'orq' });
    const idMap = new Map([['orq', 'new-orq']]); // filho ausente
    expect(computeParentUpdates([w], idMap)).toEqual([]);
  });
});

describe('planAgentClone', () => {
  it('ordena orquestradores antes dos workers e integra o filtro', () => {
    const w = makeAgent({ id: 'w', kind: AiAgentKind.WORKER, department: 'JURIDICO' });
    const orq = makeAgent({ id: 'orq', kind: AiAgentKind.ORCHESTRATOR });
    const vendas = makeAgent({ id: 'vnd', kind: AiAgentKind.WORKER, department: 'VENDAS' });

    const plan = planAgentClone([w, orq, vendas], {
      selectors: [{ kind: AiAgentKind.ORCHESTRATOR }, { department: 'JURIDICO' }],
    });

    expect(plan.map((p) => p.sourceId)).toEqual(['orq', 'w']);
    expect(plan.every((p) => !('parentAgentId' in p.data))).toBe(true);
  });
});
