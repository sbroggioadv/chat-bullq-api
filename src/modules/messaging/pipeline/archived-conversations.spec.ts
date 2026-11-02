import { ChannelType, ConversationStatus } from '@prisma/client';
import { ConversationResolverService } from './conversation-resolver.service';
import { HistoryImportService } from './history-import.service';

// Conversa arquivada (ex.: duplicada fundida pela limpeza) nunca é escolhida
// para receber mensagem nova — nem pelo resolvedor ao vivo, nem pelo importador.

type Row = {
  id: string;
  organizationId: string;
  channelId: string;
  contactId: string;
  status: ConversationStatus;
  isArchived: boolean;
  isGroup: boolean;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  deletedAt: Date | null;
  metadata: Record<string, unknown>;
};

const NOW = new Date('2026-11-02T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function conv(over: Partial<Row> & { id: string }): Row {
  return {
    organizationId: 'org',
    channelId: 'channel',
    contactId: 'contact',
    status: ConversationStatus.OPEN,
    isArchived: false,
    isGroup: false,
    lastMessageAt: minutesAgo(60),
    createdAt: minutesAgo(6000),
    updatedAt: minutesAgo(60),
    closedAt: null,
    deletedAt: null,
    metadata: {},
    ...over,
  };
}

function matches(row: Row, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'status') {
      return cond && typeof cond === 'object' && 'in' in cond
        ? cond.in.includes(row.status)
        : row.status === cond;
    }
    if (key === 'metadata') {
      const value = (cond.path as string[]).reduce<any>((acc, k) => acc?.[k], row.metadata);
      return value === cond.equals;
    }
    if (key in row) return (row as any)[key] === cond;
    throw new Error(`fake: filtro não suportado: ${key}`);
  });
}

function compare(a: Row, b: Row, orderBy: any[]): number {
  for (const entry of orderBy) {
    const [key, spec] = Object.entries(entry)[0] as [keyof Row, any];
    const dir = typeof spec === 'string' ? spec : spec.sort;
    // Postgres: sem NULLS explícito, DESC põe nulos primeiro e ASC por último.
    const nulls = (typeof spec === 'object' && spec.nulls) || (dir === 'desc' ? 'first' : 'last');
    const va = a[key] as any;
    const vb = b[key] as any;
    if (va === vb) continue;
    if (va === null || vb === null) return (va === null) === (nulls === 'first') ? -1 : 1;
    const x = va instanceof Date ? va.getTime() : va;
    const y = vb instanceof Date ? vb.getTime() : vb;
    if (x === y) continue;
    return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
  }
  return 0; // sem ordem: devolve na ordem física (arbitrária no banco)
}

function fakeFindFirst(rows: Row[]) {
  return jest.fn(async ({ where, orderBy }: any) => {
    const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].filter((r) => matches(r, where)).sort((a, b) => compare(a, b, order))[0] ?? null;
  });
}

function prismaWith(rows: Row[]) {
  return {
    conversation: {
      findFirst: fakeFindFirst(rows),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: 'nova' }),
    },
    conversationAuditLog: { create: jest.fn() },
    contactChannel: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'cc', contactId: 'contact', profileName: 'Nome', contact: { organizationId: 'org' },
      }),
      update: jest.fn(),
    },
  };
}

describe('resolvedor ao vivo — conversa arquivada nunca é escolhida', () => {
  const idempotency = { withLock: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()) };
  const resolve = (prisma: any) =>
    new ConversationResolverService(prisma, idempotency as any).resolve('org', 'channel', 'contact');

  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime()));
  afterEach(() => jest.restoreAllMocks());

  it('original aberta + extra arquivada → escolhe a original', async () => {
    const prisma = prismaWith([
      conv({ id: 'original', lastMessageAt: minutesAgo(30), updatedAt: minutesAgo(30) }),
      conv({ id: 'extra', isArchived: true, lastMessageAt: minutesAgo(10), updatedAt: minutesAgo(1) }),
    ]);

    const result = await resolve(prisma);

    expect(result).toEqual({ conversationId: 'original', status: ConversationStatus.OPEN, isNew: false, wasReopened: false });
  });

  it('original FECHADA há menos de 24h + extra arquivada → reabre a original, nunca a extra', async () => {
    const prisma = prismaWith([
      conv({ id: 'original', status: ConversationStatus.CLOSED, closedAt: minutesAgo(60) }),
      conv({ id: 'extra', isArchived: true, updatedAt: minutesAgo(1) }),
    ]);

    const result = await resolve(prisma);

    expect(result).toMatchObject({ conversationId: 'original', wasReopened: true, isNew: false });
    expect(prisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'original' } }));
    expect(prisma.conversation.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'extra' } }));
  });

  it('original FECHADA há mais de 24h + extra arquivada → cria conversa nova', async () => {
    const prisma = prismaWith([
      conv({ id: 'original', status: ConversationStatus.CLOSED, closedAt: minutesAgo(30 * 60) }),
      conv({ id: 'extra', isArchived: true, updatedAt: minutesAgo(1) }),
    ]);

    const result = await resolve(prisma);

    expect(result).toMatchObject({ conversationId: 'nova', isNew: true });
    expect(prisma.conversation.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('só arquivadas → comportamento de "sem conversa aberta" (cria conversa nova)', async () => {
    const prisma = prismaWith([
      conv({ id: 'arq-1', isArchived: true, status: ConversationStatus.PENDING }),
      conv({ id: 'arq-2', isArchived: true, status: ConversationStatus.OPEN }),
    ]);

    const result = await resolve(prisma);

    expect(result).toMatchObject({ conversationId: 'nova', isNew: true, wasReopened: false });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('não reabre uma arquivada fechada mais recente que a original fechada', async () => {
    const prisma = prismaWith([
      conv({ id: 'original', status: ConversationStatus.CLOSED, closedAt: minutesAgo(120) }),
      conv({ id: 'extra', isArchived: true, status: ConversationStatus.CLOSED, closedAt: minutesAgo(30) }),
    ]);

    const result = await resolve(prisma);

    expect(result).toMatchObject({ conversationId: 'original', wasReopened: true });
  });

  it.each([
    {
      caso: 'mensagem mais recente vence, mesmo com a outra atualizada depois',
      rows: [
        conv({ id: 'velha', lastMessageAt: minutesAgo(120), updatedAt: minutesAgo(1) }),
        conv({ id: 'recente', lastMessageAt: minutesAgo(5), updatedAt: minutesAgo(5) }),
      ],
      esperado: 'recente',
    },
    {
      caso: 'mesmo lastMessageAt → createdAt mais recente',
      rows: [
        conv({ id: 'antiga', lastMessageAt: minutesAgo(5), createdAt: minutesAgo(900), updatedAt: minutesAgo(1) }),
        conv({ id: 'nova-criada', lastMessageAt: minutesAgo(5), createdAt: minutesAgo(100), updatedAt: minutesAgo(5) }),
      ],
      esperado: 'nova-criada',
    },
    {
      caso: 'mesmo lastMessageAt e createdAt → maior id',
      rows: [
        conv({ id: 'conv-a', lastMessageAt: minutesAgo(5), createdAt: minutesAgo(100), updatedAt: minutesAgo(1) }),
        conv({ id: 'conv-b', lastMessageAt: minutesAgo(5), createdAt: minutesAgo(100), updatedAt: minutesAgo(5) }),
      ],
      esperado: 'conv-b',
    },
    {
      caso: 'lastMessageAt nulo fica por último',
      rows: [
        conv({ id: 'sem-mensagem', lastMessageAt: null, createdAt: minutesAgo(1), updatedAt: minutesAgo(1) }),
        conv({ id: 'com-mensagem', lastMessageAt: minutesAgo(300), updatedAt: minutesAgo(300) }),
      ],
      esperado: 'com-mensagem',
    },
  ])('duas abertas não arquivadas — $caso', async ({ rows, esperado }) => {
    const prisma = prismaWith(rows);

    const result = await resolve(prisma);

    expect(result.conversationId).toBe(esperado);
  });

  it('conversa desarquivada volta a ser escolhida', async () => {
    const original = conv({ id: 'original', isArchived: true });
    const prisma = prismaWith([original]);

    const arquivada = await resolve(prisma);
    original.isArchived = false; // desarquivar manual pelo usuário
    const desarquivada = await resolve(prisma);

    expect(arquivada).toMatchObject({ conversationId: 'nova', isNew: true });
    expect(desarquivada).toMatchObject({ conversationId: 'original', isNew: false });
  });
});

describe('importador de histórico — conversa arquivada nunca é escolhida', () => {
  const channel = (type: ChannelType): any => ({ id: 'channel', organizationId: 'org', type });
  const normalized = (over: Record<string, unknown> = {}): any => ({
    externalContactId: 'contact-external',
    contactName: 'Nome',
    externalConversationId: 'thread-1',
    lastMessageAt: minutesAgo(1),
    ...over,
  });
  const importar = (prisma: any, type: ChannelType = ChannelType.WHATSAPP_ZAPPFY, n = normalized()) =>
    new HistoryImportService(prisma, {} as any).importConversation(channel(type), n);

  it('busca por externalConversationId ignora a extra arquivada que ainda tem o id', async () => {
    const prisma = prismaWith([
      conv({ id: 'extra', isArchived: true, metadata: { externalConversationId: 'thread-1' } }),
      conv({ id: 'original' }),
    ]);

    const result = await importar(prisma);

    expect(result).toEqual({ conversationId: 'original', contactId: 'contact', isNew: false });
  });

  it('busca por contato ignora a arquivada, mesmo que o banco a devolva primeiro', async () => {
    const prisma = prismaWith([
      conv({ id: 'extra', isArchived: true, lastMessageAt: minutesAgo(1) }),
      conv({ id: 'original', lastMessageAt: minutesAgo(90) }),
    ]);

    const result = await importar(prisma);

    expect(result.conversationId).toBe('original');
  });

  it('busca por contato com duas abertas → a de mensagem mais recente, não a primeira do banco', async () => {
    const prisma = prismaWith([
      conv({ id: 'velha', lastMessageAt: minutesAgo(500) }),
      conv({ id: 'recente', lastMessageAt: minutesAgo(5) }),
    ]);

    const result = await importar(prisma);

    expect(result.conversationId).toBe('recente');
  });

  it('só arquivadas → importa em conversa nova', async () => {
    const prisma = prismaWith([
      conv({ id: 'extra', isArchived: true, metadata: { externalConversationId: 'thread-1' } }),
    ]);

    const result = await importar(prisma);

    expect(result).toMatchObject({ conversationId: 'nova', isNew: true });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('conversa desarquivada volta a ser escolhida', async () => {
    const original = conv({ id: 'original', isArchived: true });
    const prisma = prismaWith([original]);

    const arquivada = await importar(prisma);
    original.isArchived = false;
    const desarquivada = await importar(prisma);

    expect(arquivada).toMatchObject({ conversationId: 'nova', isNew: true });
    expect(desarquivada).toMatchObject({ conversationId: 'original', isNew: false });
  });

  it('Gmail continua uma conversa por thread (SPEC-016): reaproveita a thread e não busca por contato', async () => {
    const prisma = prismaWith([
      conv({ id: 'thread-gmail', metadata: { externalConversationId: 'thread-1' } }),
      conv({ id: 'outra-do-contato', lastMessageAt: minutesAgo(1) }),
    ]);

    const mesma = await importar(prisma, ChannelType.GMAIL);
    const nova = await importar(prisma, ChannelType.GMAIL, normalized({ externalConversationId: 'thread-2' }));

    expect(mesma).toMatchObject({ conversationId: 'thread-gmail', isNew: false });
    expect(nova).toMatchObject({ conversationId: 'nova', isNew: true });
  });
});
