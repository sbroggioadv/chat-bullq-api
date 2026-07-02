import { AgentRouterService } from './agent-router.service';
import { GroupMentionDetector } from '../scope/group-mention-detector.service';
import { IntentType } from '../classifier/intent.types';

/**
 * S23 — selectAgent: fix cross-brand (resolução por nome restrita ao canal)
 * + catálogo dinâmico gated por AI_CLASSIFIER_DYNAMIC_ENABLED.
 */

type LinkFixture = {
  channelId: string;
  mode: string;
  agent: {
    id: string;
    name: string;
    kind: string;
    isActive: boolean;
    deletedAt: null;
    description: string | null;
    department: string | null;
    capabilities: string[];
  };
};

const matchLink = (l: LinkFixture, where: any): boolean => {
  if (where.channelId !== undefined && l.channelId !== where.channelId) return false;
  if (where.mode !== undefined && l.mode !== where.mode) return false;
  const wa = where.agent ?? {};
  if (wa.name !== undefined && l.agent.name !== wa.name) return false;
  if (wa.kind !== undefined && l.agent.kind !== wa.kind) return false;
  if (wa.isActive !== undefined && l.agent.isActive !== wa.isActive) return false;
  if (wa.deletedAt !== undefined && l.agent.deletedAt !== wa.deletedAt) return false;
  return true;
};

const makeDeps = () => {
  const links: LinkFixture[] = [];
  return {
    state: { links },
    prisma: {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ aiClassifierThreshold: null }),
      },
      aiAgent: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      aiAgentChannel: {
        findFirst: jest.fn(async ({ where }: any) => links.find((l) => matchLink(l, where)) ?? null),
        findMany: jest.fn(async ({ where }: any) => links.filter((l) => matchLink(l, where))),
      },
    },
    classifier: {
      classify: jest.fn(),
    },
  };
};

const worker = (channelId: string, id: string, name: string, extra: Partial<LinkFixture['agent']> = {}): LinkFixture => ({
  channelId,
  mode: 'AUTONOMOUS',
  agent: {
    id, name, kind: 'WORKER', isActive: true, deletedAt: null,
    description: null, department: null, capabilities: [], ...extra,
  },
});

const orchestrator = (channelId: string, id: string, name: string): LinkFixture => ({
  channelId,
  mode: 'AUTONOMOUS',
  agent: {
    id, name, kind: 'ORCHESTRATOR', isActive: true, deletedAt: null,
    description: null, department: null, capabilities: [],
  },
});

const classification = (over: Record<string, unknown> = {}) => ({
  intent: IntentType.AGENT_MATCH,
  confidence: 0.95,
  reasoning: 'test',
  suggestedAgent: null,
  skippedOrchestrator: false,
  modelUsed: 'claude-haiku-4-5',
  costUsd: 0.0003,
  durationMs: 100,
  ...over,
});

describe('AgentRouterService — S23 selectAgent (cross-brand fix + catálogo dinâmico)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let svc: AgentRouterService;

  const conv = {
    id: 'c1', organizationId: 'org-1', channelId: 'ch-brand-b',
    activeAgentId: null, aiEnabled: null,
  };

  beforeEach(() => {
    deps = makeDeps();
    svc = new AgentRouterService(
      deps.prisma as any,
      deps.classifier as any,
      {} as any, // intentRouter — não usado pelo selectAgent
      {} as unknown as GroupMentionDetector,
    );
    delete process.env.AI_CLASSIFIER_DYNAMIC_ENABLED;
  });

  afterEach(() => {
    delete process.env.AI_CLASSIFIER_DYNAMIC_ENABLED;
  });

  it('B2: nome sugerido de agente de OUTRO canal (outra marca) NÃO é selecionado → fallback orchestrator do canal', async () => {
    // Daniel pertence à marca A (ch-brand-a); a conversa é do canal da marca B.
    deps.state.links.push(
      worker('ch-brand-a', 'w-daniel', 'Daniel Souza'),
      worker('ch-brand-b', 'w-sdr-b', 'SDR Marca B'),
      orchestrator('ch-brand-b', 'o-b', 'Orquestrador B'),
    );
    deps.classifier.classify.mockResolvedValue(
      classification({ intent: IntentType.SALES_GENERAL, suggestedAgent: 'Daniel Souza', skippedOrchestrator: true }),
    );

    const r = await svc.selectAgent(conv as any, 'quero comprar');
    expect(r?.agentId).toBe('o-b');
    expect(r?.agentName).toBe('Orquestrador B');
    expect(r?.skippedOrchestrator).toBe(false);
  });

  it('B2: nome sugerido vinculado ao canal da conversa → selecionado direto', async () => {
    deps.state.links.push(
      worker('ch-brand-b', 'w-sdr-b', 'SDR Marca B'),
      orchestrator('ch-brand-b', 'o-b', 'Orquestrador B'),
    );
    deps.classifier.classify.mockResolvedValue(
      classification({ suggestedAgent: 'SDR Marca B', skippedOrchestrator: true }),
    );

    const r = await svc.selectAgent(conv as any, 'quero comprar');
    expect(r?.agentId).toBe('w-sdr-b');
    expect(r?.skippedOrchestrator).toBe(true);
  });

  it('B2: agente com mesmo nome mas vínculo não-AUTONOMOUS no canal → fallback', async () => {
    deps.state.links.push(
      { ...worker('ch-brand-b', 'w-copilot', 'SDR Marca B'), mode: 'COPILOT' },
      orchestrator('ch-brand-b', 'o-b', 'Orquestrador B'),
    );
    deps.classifier.classify.mockResolvedValue(
      classification({ suggestedAgent: 'SDR Marca B', skippedOrchestrator: true }),
    );

    const r = await svc.selectAgent(conv as any, 'quero comprar');
    expect(r?.agentId).toBe('o-b');
  });

  it('B3: flag ON + canal SEM worker → pula classifier (zero chamada Haiku) e cai no orchestrator', async () => {
    process.env.AI_CLASSIFIER_DYNAMIC_ENABLED = 'true';
    deps.state.links.push(orchestrator('ch-brand-b', 'o-b', 'Orquestrador B'));

    const r = await svc.selectAgent(conv as any, 'oi');
    expect(deps.classifier.classify).not.toHaveBeenCalled();
    expect(r?.agentId).toBe('o-b');
  });

  it('B3: flag ON → catálogo passado ao classifier lista SÓ workers AUTONOMOUS do canal da conversa', async () => {
    process.env.AI_CLASSIFIER_DYNAMIC_ENABLED = 'true';
    deps.state.links.push(
      worker('ch-brand-b', 'w1', 'SDR Marca B', { department: 'VENDAS', description: 'Vende produto B' }),
      worker('ch-brand-b', 'w2', 'Suporte Marca B'),
      worker('ch-brand-a', 'w3', 'SDR Marca A'), // outra marca — fora do catálogo
      orchestrator('ch-brand-b', 'o-b', 'Orquestrador B'), // orchestrator — fora do catálogo
    );
    deps.classifier.classify.mockResolvedValue(
      classification({ intent: IntentType.AMBIGUOUS, confidence: 0.3 }),
    );

    await svc.selectAgent(conv as any, 'mensagem qualquer');
    expect(deps.classifier.classify).toHaveBeenCalledTimes(1);
    const cfg = deps.classifier.classify.mock.calls[0][2];
    expect(cfg.agentCatalog.map((a: any) => a.name)).toEqual(['SDR Marca B', 'Suporte Marca B']);
    expect(cfg.agentCatalog[0]).toMatchObject({ department: 'VENDAS', description: 'Vende produto B' });
  });

  it('B3: flag OFF (default) → comportamento antigo: sem query de catálogo, classify sem agentCatalog', async () => {
    deps.state.links.push(
      worker('ch-brand-b', 'w-sdr-b', 'SDR Marca B'),
      orchestrator('ch-brand-b', 'o-b', 'Orquestrador B'),
    );
    deps.classifier.classify.mockResolvedValue(
      classification({ intent: IntentType.SMALL_TALK, confidence: 0.9 }),
    );

    const r = await svc.selectAgent(conv as any, 'bom dia');
    expect(deps.prisma.aiAgentChannel.findMany).not.toHaveBeenCalled();
    const cfg = deps.classifier.classify.mock.calls[0][2];
    expect(cfg.agentCatalog).toBeUndefined();
    expect(r?.agentId).toBe('o-b');
  });

  it('conversa com activeAgentId mantém o agente atual sem classificar', async () => {
    deps.prisma.aiAgent.findUnique.mockResolvedValue({ id: 'w-atual', name: 'SDR Atual' });
    const r = await svc.selectAgent(
      { ...conv, activeAgentId: 'w-atual' } as any,
      'continua o papo',
    );
    expect(deps.classifier.classify).not.toHaveBeenCalled();
    expect(r?.agentId).toBe('w-atual');
  });
});
