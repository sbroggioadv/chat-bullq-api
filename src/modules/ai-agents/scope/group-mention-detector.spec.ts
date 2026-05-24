import { GroupMentionDetector } from './group-mention-detector.service';

type FakeAgent = { id: string; mentionHandle: string | null };
type FakeMessage = {
  content: any;
  metadata?: any;
};

const makePrisma = () => ({
  message: {
    findUnique: jest.fn(),
  },
});

describe('GroupMentionDetector', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let detector: GroupMentionDetector;

  beforeEach(() => {
    prisma = makePrisma();
    detector = new GroupMentionDetector(prisma as any);
  });

  const agents: FakeAgent[] = [
    { id: 'a1', mentionHandle: 'vendas' },
    { id: 'a2', mentionHandle: 'suporte' },
    { id: 'a3', mentionHandle: null }, // sem handle — nunca matcha por texto
  ];

  it('matcha agente quando texto contém @handle case-insensitive', async () => {
    const msg: FakeMessage = { content: { text: 'oi @Vendas, tem desconto?' } };
    const r = await detector.findMatchingAgent(msg as any, agents as any);
    expect(r?.id).toBe('a1');
  });

  it('matcha caption de mídia quando contém @handle', async () => {
    const msg: FakeMessage = { content: { caption: 'pessoal @suporte vejam isso', mediaUrl: 'x' } };
    const r = await detector.findMatchingAgent(msg as any, agents as any);
    expect(r?.id).toBe('a2');
  });

  it('NÃO matcha email com @ (luis@vendas.com)', async () => {
    const msg: FakeMessage = { content: { text: 'meu email luis@vendas.com' } };
    const r = await detector.findMatchingAgent(msg as any, agents as any);
    expect(r).toBeNull();
  });

  it('NÃO matcha handle prefixado por outros chars (@vendas123)', async () => {
    const msg: FakeMessage = { content: { text: 'pergunta pro @vendas123 ali' } };
    const r = await detector.findMatchingAgent(msg as any, agents as any);
    expect(r).toBeNull();
  });

  it('matcha reply nativo a msg de IA do mesmo agente', async () => {
    prisma.message.findUnique.mockResolvedValueOnce({
      id: 'msg-original',
      senderId: null,
      metadata: { aiAgentId: 'a1' },
    });
    const msg: FakeMessage = {
      content: { text: 'obrigado' },
      metadata: { replyTo: { messageId: 'msg-original' } },
    };
    const r = await detector.findMatchingAgent(msg as any, agents as any);
    expect(r?.id).toBe('a1');
    expect(prisma.message.findUnique).toHaveBeenCalledWith({
      where: { id: 'msg-original' },
      select: { id: true, senderId: true, metadata: true },
    });
  });

  it('NÃO matcha reply quando msg original tem senderId (não é IA)', async () => {
    prisma.message.findUnique.mockResolvedValueOnce({
      id: 'msg-original',
      senderId: 'user-123',
      metadata: { aiAgentId: 'a1' },
    });
    const msg: FakeMessage = {
      content: { text: 'ok' },
      metadata: { replyTo: { messageId: 'msg-original' } },
    };
    const r = await detector.findMatchingAgent(msg as any, agents as any);
    expect(r).toBeNull();
  });

  it('ignora candidatos sem mentionHandle (null)', async () => {
    const msg: FakeMessage = { content: { text: 'oi pessoal' } };
    const r = await detector.findMatchingAgent(msg as any, [agents[2]] as any);
    expect(r).toBeNull();
  });

  it('regex chars no handle não causam crash (escape interno)', async () => {
    // Defesa contra handles maliciosos no banco — só `[a-z0-9_-]+` deveria
    // passar pela validação do DTO, mas o detector deve ser defensivo.
    const weirdAgents: FakeAgent[] = [{ id: 'a4', mentionHandle: 'foo.*bar' }];
    const msg: FakeMessage = { content: { text: 'oi @qualquercoisa' } };
    const r = await detector.findMatchingAgent(msg as any, weirdAgents as any);
    expect(r).toBeNull(); // não matcha por regex injection
  });
});
