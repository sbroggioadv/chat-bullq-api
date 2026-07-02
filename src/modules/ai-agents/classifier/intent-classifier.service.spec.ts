import { IntentClassifierService } from './intent-classifier.service';
import { IntentRouterService } from './intent-router.service';
import { IntentType, ClassifierAgentCatalogEntry } from './intent.types';

/**
 * S23 — classifier em modo dinâmico (catálogo por canal) vs estático (legado).
 */

const makeLlm = () => ({
  complete: jest.fn(),
});

const llmResponse = (json: Record<string, unknown>) => ({
  message: { content: [{ type: 'text', text: JSON.stringify(json) }] },
  usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0003 },
  rawModelId: 'claude-haiku-4-5',
});

const catalog: ClassifierAgentCatalogEntry[] = [
  {
    name: 'Ana Beta',
    description: 'SDR da marca Beta — cursos de gestão',
    department: 'VENDAS',
    capabilities: ['qualificação', 'agendamento'],
  },
  {
    name: 'Caio Gama',
    description: null,
    department: 'SUPORTE',
    capabilities: [],
  },
];

describe('IntentClassifierService — S23 catálogo dinâmico', () => {
  let llm: ReturnType<typeof makeLlm>;
  let svc: IntentClassifierService;

  const systemPromptSent = (): string =>
    llm.complete.mock.calls[0][0].messages[0].content[0].text;

  beforeEach(() => {
    llm = makeLlm();
    svc = new IntentClassifierService(llm as any, new IntentRouterService());
  });

  it('sem catálogo (flag off) → prompt estático com personas hardcoded, comportamento antigo intacto', async () => {
    llm.complete.mockResolvedValue(
      llmResponse({
        intent: 'SALES_GENERAL',
        confidence: 0.95,
        reasoning: 'quer tráfego pago',
        suggestedAgent: 'Daniel Souza',
      }),
    );

    const r = await svc.classify('quero anunciar no Instagram');
    expect(systemPromptSent()).toContain('Daniel Souza');
    expect(r.intent).toBe(IntentType.SALES_GENERAL);
    expect(r.suggestedAgent).toBe('Daniel Souza');
    expect(r.skippedOrchestrator).toBe(true);
  });

  it('sem catálogo → nome bruto do LLM NÃO propaga: suggestedAgent vem só do mapa validado', async () => {
    llm.complete.mockResolvedValue(
      llmResponse({
        intent: 'SALES_GENERAL',
        confidence: 0.95,
        reasoning: 'quer tráfego pago',
        suggestedAgent: 'Nome Inventado Pelo Modelo',
      }),
    );

    const r = await svc.classify('quero anunciar no Instagram');
    expect(r.suggestedAgent).toBe('Daniel Souza'); // mapa SALES_GENERAL, não o raw
    expect(r.skippedOrchestrator).toBe(true);
  });

  it('com catálogo → prompt dinâmico lista só os agentes do canal (sem personas hardcoded)', async () => {
    llm.complete.mockResolvedValue(
      llmResponse({
        intent: 'AGENT_MATCH',
        confidence: 0.95,
        reasoning: 'área da Ana',
        suggestedAgent: 'Ana Beta',
      }),
    );

    const r = await svc.classify('quero o curso de gestão', [], {
      agentCatalog: catalog,
    });
    const prompt = systemPromptSent();
    expect(prompt).toContain('Ana Beta');
    expect(prompt).toContain('Caio Gama');
    expect(prompt).toContain('cursos de gestão');
    expect(prompt).not.toContain('Daniel Souza');
    expect(r.intent).toBe(IntentType.AGENT_MATCH);
    expect(r.suggestedAgent).toBe('Ana Beta');
    expect(r.skippedOrchestrator).toBe(true);
  });

  it('com catálogo → nome fora do catálogo (agente de outra marca) NÃO passa: sem skip, suggestedAgent null', async () => {
    llm.complete.mockResolvedValue(
      llmResponse({
        intent: 'AGENT_MATCH',
        confidence: 0.97,
        reasoning: 'alucinou persona do upstream',
        suggestedAgent: 'Daniel Souza',
      }),
    );

    const r = await svc.classify('quero comprar', [], { agentCatalog: catalog });
    expect(r.suggestedAgent).toBeNull();
    expect(r.skippedOrchestrator).toBe(false);
  });

  it('com catálogo → "NONE" vira null e não pula orchestrator', async () => {
    llm.complete.mockResolvedValue(
      llmResponse({
        intent: 'SMALL_TALK',
        confidence: 0.9,
        reasoning: 'só um oi',
        suggestedAgent: 'NONE',
      }),
    );

    const r = await svc.classify('bom dia', [], { agentCatalog: catalog });
    expect(r.suggestedAgent).toBeNull();
    expect(r.skippedOrchestrator).toBe(false);
  });

  it('com catálogo → match case-insensitive devolve o nome canônico do banco', async () => {
    llm.complete.mockResolvedValue(
      llmResponse({
        intent: 'AGENT_MATCH',
        confidence: 0.92,
        reasoning: 'casing diferente',
        suggestedAgent: 'ana beta',
      }),
    );

    const r = await svc.classify('curso de gestão', [], { agentCatalog: catalog });
    expect(r.suggestedAgent).toBe('Ana Beta');
    expect(r.skippedOrchestrator).toBe(true);
  });

  it('com catálogo → confidence abaixo do threshold não pula orchestrator mesmo com match', async () => {
    llm.complete.mockResolvedValue(
      llmResponse({
        intent: 'AGENT_MATCH',
        confidence: 0.7,
        reasoning: 'indício fraco',
        suggestedAgent: 'Caio Gama',
      }),
    );

    const r = await svc.classify('acho que preciso de ajuda', [], {
      agentCatalog: catalog,
      threshold: 0.85,
    });
    expect(r.suggestedAgent).toBe('Caio Gama');
    expect(r.skippedOrchestrator).toBe(false);
  });

  it('falha do LLM → AMBIGUOUS sem skip (fallback seguro), com ou sem catálogo', async () => {
    llm.complete.mockRejectedValue(new Error('provider down'));

    const r = await svc.classify('qualquer coisa', [], { agentCatalog: catalog });
    expect(r.intent).toBe(IntentType.AMBIGUOUS);
    expect(r.skippedOrchestrator).toBe(false);
    expect(r.suggestedAgent).toBeNull();
  });
});
