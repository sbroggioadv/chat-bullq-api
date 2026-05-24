import { AgentCadenceController } from './agent-cadence-controller.service';

const makeDeps = () => {
  const aiResponseLogs: any[] = [];
  const messages: any[] = [];
  return {
    state: { aiResponseLogs, messages },
    prisma: {
      aiResponseLog: {
        count: jest.fn(async ({ where }: any) => {
          // simula filtro channelId + sentAt >= cutoff
          return aiResponseLogs.filter((l) =>
            (!where.channelId || l.channelId === where.channelId) &&
            (!where.sentAt?.gte || l.sentAt >= where.sentAt.gte)
          ).length;
        }),
      },
      message: {
        findFirst: jest.fn(async ({ where, orderBy }: any) => {
          const filtered = messages
            .filter((m) =>
              (!where.conversationId || m.conversationId === where.conversationId) &&
              (!where.direction || m.direction === where.direction)
            )
            .sort((a, b) => (orderBy?.createdAt === 'desc' ? b.createdAt - a.createdAt : 0));
          return filtered[0] ?? null;
        }),
        count: jest.fn(async ({ where }: any) => {
          return messages.filter((m) =>
            (!where.conversationId || m.conversationId === where.conversationId) &&
            (!where.direction || m.direction === where.direction) &&
            (where.senderId === undefined || m.senderId === where.senderId) &&
            (!where.createdAt?.gt || m.createdAt > where.createdAt.gt)
          ).length;
        }),
      },
    },
  };
};

describe('AgentCadenceController', () => {
  let deps: ReturnType<typeof makeDeps>;
  let controller: AgentCadenceController;

  const baseAgent = {
    id: 'agent-1',
    rateLimitPerHour: 10,
    consecutiveMsgCap: 3,
    humanizationEnabled: true,
    minDelayMs: 15000,
  };

  beforeEach(() => {
    deps = makeDeps();
    controller = new AgentCadenceController(deps.prisma as any);
  });

  it('bloqueia quando cap horário do canal estourou', async () => {
    // 10 logs no último hora — bate cap=10
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      deps.state.aiResponseLogs.push({ channelId: 'ch-1', sentAt: new Date(now - i * 60_000) });
    }
    const r = await controller.evaluate('ch-1', 'conv-1', baseAgent as any, 'oi', 'olá');
    expect(r.shouldSend).toBe(false);
    expect(r.reason).toBe('CHANNEL_CAP_HOUR');
  });

  it('bloqueia quando cap consecutivo da conversa estourou (sem reply do cliente)', async () => {
    const now = Date.now();
    // último inbound foi há 1h
    deps.state.messages.push({
      conversationId: 'conv-1',
      direction: 'INBOUND',
      senderId: 'contact-x',
      createdAt: now - 3600_000,
    });
    // 3 outbound de IA (senderId=null) DEPOIS do inbound — bate cap=3
    for (let i = 0; i < 3; i++) {
      deps.state.messages.push({
        conversationId: 'conv-1',
        direction: 'OUTBOUND',
        senderId: null,
        createdAt: now - (3000_000 - i * 600_000),
      });
    }
    const r = await controller.evaluate('ch-1', 'conv-1', baseAgent as any, 'r', 'i');
    expect(r.shouldSend).toBe(false);
    expect(r.reason).toBe('CONV_CONSECUTIVE_CAP');
  });

  it('não conta msgs OUTBOUND de humanos (senderId != null) no cap consecutivo', async () => {
    const now = Date.now();
    deps.state.messages.push({
      conversationId: 'conv-1', direction: 'INBOUND', senderId: 'contact-x', createdAt: now - 3600_000,
    });
    // 4 outbound, mas todas com senderId (humano) — não conta como IA
    for (let i = 0; i < 4; i++) {
      deps.state.messages.push({
        conversationId: 'conv-1', direction: 'OUTBOUND', senderId: 'user-luis', createdAt: now - (3000_000 - i * 600_000),
      });
    }
    const r = await controller.evaluate('ch-1', 'conv-1', baseAgent as any, 'r', 'i');
    expect(r.shouldSend).toBe(true);
  });

  it('aplica delay mínimo quando humanização ON e base_delay menor', async () => {
    const minimal = { ...baseAgent, minDelayMs: 30_000 };
    const r = await controller.evaluate('ch-1', 'conv-1', minimal as any, 'oi', 'olá');
    expect(r.shouldSend).toBe(true);
    expect(r.delayMs).toBeGreaterThanOrEqual(30_000);
  });

  it('delay = 0 quando humanização OFF e minDelayMs = 0', async () => {
    const agent = { ...baseAgent, humanizationEnabled: false, minDelayMs: 0 };
    const r = await controller.evaluate('ch-1', 'conv-1', agent as any, 'oi', 'olá');
    expect(r.shouldSend).toBe(true);
    expect(r.delayMs).toBe(0);
  });

  it('typing_ms cap em 60s mesmo com response longa', async () => {
    const longResponse = 'palavra '.repeat(2000); // ~12000 chars → typing_ms cru ~654s
    const agent = { ...baseAgent, minDelayMs: 0 };
    const r = await controller.evaluate('ch-1', 'conv-1', agent as any, longResponse, 'oi');
    expect(r.shouldSend).toBe(true);
    // teto: 12s reading + 20s thinking + 60s typing = 92s
    expect(r.delayMs).toBeLessThanOrEqual(92_000);
  });

  it('jitter dá range estatístico esperado em 100 evaluations', async () => {
    const agent = { ...baseAgent, minDelayMs: 0 };
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      const r = await controller.evaluate('ch-1', 'conv-1', agent as any, 'resposta normal', 'mensagem inbound normal');
      if (r.shouldSend) delays.push(r.delayMs);
    }
    expect(delays.length).toBe(100);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(8000); // 3+5+0 mín
    expect(Math.max(...delays)).toBeLessThanOrEqual(92_000); // cap teórico
    // variância mínima — jitter aleatório
    const unique = new Set(delays);
    expect(unique.size).toBeGreaterThan(50);
  });

  it('OK normal retorna shouldSend=true e reason=OK', async () => {
    const r = await controller.evaluate('ch-1', 'conv-1', baseAgent as any, 'olá tudo bem?', 'oi');
    expect(r.shouldSend).toBe(true);
    expect(r.reason).toBe('OK');
    expect(r.delayMs).toBeGreaterThan(0);
  });
});
