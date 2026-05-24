import { MessagesService } from './messages.service';
import { MessageContentType, MessageDirection, MessageStatus } from '@prisma/client';

// Helpers ---------------------------------------------------------------

type FakeMessage = {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  type: MessageContentType;
  content: Record<string, any>;
  status: MessageStatus;
  externalId?: string | null;
  revokedAt?: Date | null;
};

type FakeConversation = {
  id: string;
  organizationId: string;
  channelId: string;
  isGroup: boolean;
};

const makeDeps = () => {
  const messages = new Map<string, FakeMessage>();
  const conversations = new Map<string, FakeConversation>();
  const mediaResolves: Array<{ id: string; forceRefresh: boolean }> = [];
  const sendCalls: Array<{ conversationId: string; type: string; content: any; senderId: string; orgId: string }> = [];
  const queueDelays: number[] = [];

  return {
    state: { messages, conversations, mediaResolves, sendCalls, queueDelays },
    prisma: {
      message: {
        findFirst: jest.fn(async ({ where }: any) => {
          const m = messages.get(where.id);
          if (!m) return null;
          // simular include conversation
          return { ...m, conversation: conversations.get(m.conversationId) ?? null };
        }),
      },
      conversation: {
        findMany: jest.fn(async ({ where }: any) => {
          const ids: string[] = where.id?.in ?? [];
          return ids.map((id) => conversations.get(id)).filter(Boolean);
        }),
      },
    },
    mediaResolver: {
      resolve: jest.fn(async (id: string, _orgId: string, _access: any, opts?: { forceRefresh?: boolean }) => {
        mediaResolves.push({ id, forceRefresh: !!opts?.forceRefresh });
        return { url: 'https://re-resolved.example/file.jpg', mimeType: 'image/jpeg' };
      }),
    },
    channelAccess: {
      assertChannelAccess: jest.fn((access: any, channelId: string) => {
        if (access !== 'ALL' && !access.has(channelId)) {
          throw new Error('Forbidden channel');
        }
      }),
      hasAccess: jest.fn((access: any, channelId: string): boolean => {
        if (access === 'ALL') return true;
        return access.has(channelId);
      }),
    },
    sendImpl: jest.fn(async (dto: any, senderId: string, orgId: string) => {
      sendCalls.push({ ...dto, senderId, orgId });
      return { id: `out_${sendCalls.length}`, conversationId: dto.conversationId };
    }),
    nextTick: () => new Promise((r) => setImmediate(r)),
  };
};

const seed = (deps: ReturnType<typeof makeDeps>) => {
  deps.state.conversations.set('conv_src', { id: 'conv_src', organizationId: 'org1', channelId: 'ch_a', isGroup: false });
  deps.state.conversations.set('conv_dst_a1', { id: 'conv_dst_a1', organizationId: 'org1', channelId: 'ch_a', isGroup: false });
  deps.state.conversations.set('conv_dst_a2', { id: 'conv_dst_a2', organizationId: 'org1', channelId: 'ch_a', isGroup: true });
  deps.state.conversations.set('conv_dst_b1', { id: 'conv_dst_b1', organizationId: 'org1', channelId: 'ch_b', isGroup: false });
  deps.state.conversations.set('conv_cross', { id: 'conv_cross', organizationId: 'org2', channelId: 'ch_x', isGroup: false });
  deps.state.messages.set('msg_text', {
    id: 'msg_text',
    conversationId: 'conv_src',
    direction: MessageDirection.OUTBOUND,
    type: MessageContentType.TEXT,
    content: { text: 'olá mundo', mentions: ['ignoreme'] },
    status: MessageStatus.SENT,
    revokedAt: null,
  });
  deps.state.messages.set('msg_img_inbound', {
    id: 'msg_img_inbound',
    conversationId: 'conv_src',
    direction: MessageDirection.INBOUND,
    type: MessageContentType.IMAGE,
    content: { mediaUrl: 'https://expired.zappfy/foo.jpg', caption: 'pic', mimeType: 'image/jpeg' },
    status: MessageStatus.SENT,
    externalId: 'ext_abc',
  });
  deps.state.messages.set('msg_queued', {
    id: 'msg_queued',
    conversationId: 'conv_src',
    direction: MessageDirection.OUTBOUND,
    type: MessageContentType.TEXT,
    content: { text: 'pendente' },
    status: MessageStatus.QUEUED,
  });
  deps.state.messages.set('msg_revoked', {
    id: 'msg_revoked',
    conversationId: 'conv_src',
    direction: MessageDirection.OUTBOUND,
    type: MessageContentType.TEXT,
    content: { text: 'apagada' },
    status: MessageStatus.SENT,
    revokedAt: new Date(),
  });
};

// Factory pra montar o service só com forwardMessage exercitável.
// O service real recebe muitas deps no constructor; aqui injetamos mocks
// e expomos sendImpl como override de this.send.
const makeService = (deps: ReturnType<typeof makeDeps>) => {
  const svc = new (MessagesService as any)(
    /* repository */ {},
    /* prisma */ deps.prisma,
    /* realtimeGateway */ { emitToChannel: jest.fn(), emitToConversation: jest.fn(), emitToUser: jest.fn() },
    /* channelAccess */ deps.channelAccess,
    /* watchdog */ { cancelCheck: jest.fn().mockResolvedValue(undefined) },
    /* adapterRegistry */ {},
    /* mediaResolver */ deps.mediaResolver,
    /* outboundQueue */ { add: jest.fn() },
  );
  // Override send to count calls + capture payloads without exercising the full pipeline.
  svc.send = deps.sendImpl;
  return svc as MessagesService;
};

describe('MessagesService.forwardMessage', () => {
  let deps: ReturnType<typeof makeDeps>;
  let svc: MessagesService;
  beforeEach(() => {
    deps = makeDeps();
    seed(deps);
    svc = makeService(deps);
  });

  it('encaminha TEXT pra 2 destinos válidos da mesma org', async () => {
    const res = await (svc as any).forwardMessage(
      'msg_text',
      ['conv_dst_a1', 'conv_dst_b1'],
      'user1',
      'org1',
      'ALL',
    );
    expect(res.queued).toEqual(['conv_dst_a1', 'conv_dst_b1']);
    expect(res.rejected).toEqual([]);
    expect(deps.sendImpl).toHaveBeenCalledTimes(2);
    const dtos = deps.sendImpl.mock.calls.map((c: any) => c[0]);
    expect(dtos.map((d: any) => d.conversationId)).toEqual(['conv_dst_a1', 'conv_dst_b1']);
    expect(dtos.every((d: any) => d.type === 'TEXT')).toBe(true);
    // strip de menções:
    expect(dtos.every((d: any) => d.content.mentions === undefined)).toBe(true);
    // content.text preservado:
    expect(dtos.every((d: any) => d.content.text === 'olá mundo')).toBe(true);
  });

  it('rejeita destino cross-org com motivo claro', async () => {
    const res = await (svc as any).forwardMessage(
      'msg_text',
      ['conv_dst_a1', 'conv_cross'],
      'user1',
      'org1',
      'ALL',
    );
    expect(res.queued).toEqual(['conv_dst_a1']);
    expect(res.rejected).toEqual([
      { conversationId: 'conv_cross', reason: 'CROSS_ORG' },
    ]);
    expect(deps.sendImpl).toHaveBeenCalledTimes(1);
  });

  it('rejeita destino sem acesso de canal', async () => {
    const limitedAccess = new Set(['ch_a']); // sem ch_b
    const res = await (svc as any).forwardMessage(
      'msg_text',
      ['conv_dst_a1', 'conv_dst_b1'],
      'user1',
      'org1',
      limitedAccess,
    );
    expect(res.queued).toEqual(['conv_dst_a1']);
    expect(res.rejected).toEqual([
      { conversationId: 'conv_dst_b1', reason: 'CHANNEL_FORBIDDEN' },
    ]);
  });

  it('bloqueia forward de mensagem QUEUED com 422', async () => {
    await expect(
      (svc as any).forwardMessage('msg_queued', ['conv_dst_a1'], 'user1', 'org1', 'ALL'),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('bloqueia forward de mensagem revogada com 422', async () => {
    await expect(
      (svc as any).forwardMessage('msg_revoked', ['conv_dst_a1'], 'user1', 'org1', 'ALL'),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('re-resolve mídia inbound antes de encaminhar (força refresh)', async () => {
    await (svc as any).forwardMessage(
      'msg_img_inbound',
      ['conv_dst_a1'],
      'user1',
      'org1',
      'ALL',
    );
    expect(deps.mediaResolver.resolve).toHaveBeenCalledTimes(1);
    expect(deps.state.mediaResolves[0]).toEqual({ id: 'msg_img_inbound', forceRefresh: true });
    const sent = deps.sendImpl.mock.calls[0][0];
    expect(sent.content.mediaUrl).toBe('https://re-resolved.example/file.jpg');
    expect(sent.content.caption).toBe('pic');
    expect(sent.type).toBe('IMAGE');
  });

  it('escalonamento de delay: cada destino +1100ms; serializado por channelId', async () => {
    // 3 destinos: 2 em ch_a (a1, a2), 1 em ch_b (b1). Esperado:
    // a1 → delay 0; a2 → delay 1100; b1 → delay 0 (canal diferente reinicia)
    await (svc as any).forwardMessage(
      'msg_text',
      ['conv_dst_a1', 'conv_dst_a2', 'conv_dst_b1'],
      'user1',
      'org1',
      'ALL',
    );
    // Cada send é invocado com 5o argumento opcional `{delayMs}` que o service
    // calcula. Verificamos pela ordem dos sendCalls + extras passados.
    const calls = deps.sendImpl.mock.calls;
    expect(calls.length).toBe(3);
    // Service deve passar delayMs como 6o param. Se ainda não passa, o teste
    // captura essa lacuna.
    const delays = calls.map((c: any) => c[5] /* delayMs */);
    expect(delays).toEqual([0, 1100, 0]);
  });

  it('rejeita destino inexistente com motivo NOT_FOUND', async () => {
    const res = await (svc as any).forwardMessage(
      'msg_text',
      ['conv_dst_a1', 'conv_inexistente'],
      'user1',
      'org1',
      'ALL',
    );
    expect(res.queued).toEqual(['conv_dst_a1']);
    expect(res.rejected).toEqual([
      { conversationId: 'conv_inexistente', reason: 'NOT_FOUND' },
    ]);
  });

  it('rejeita tipo não suportado na v1 (STICKER) com motivo UNSUPPORTED_TYPE', async () => {
    deps.state.messages.set('msg_sticker', {
      id: 'msg_sticker',
      conversationId: 'conv_src',
      direction: MessageDirection.INBOUND,
      type: MessageContentType.STICKER,
      content: { mediaUrl: 'https://x/y.webp' },
      status: MessageStatus.SENT,
    });
    await expect(
      (svc as any).forwardMessage('msg_sticker', ['conv_dst_a1'], 'user1', 'org1', 'ALL'),
    ).rejects.toMatchObject({ status: 422 });
  });
});
