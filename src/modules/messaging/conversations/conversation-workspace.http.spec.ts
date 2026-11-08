import { Test } from '@nestjs/testing';
import { ConversationWorkspaceController } from './conversation-workspace.controller';
import { ConversationWorkspaceService } from './conversation-workspace.service';
import { PrismaService } from '../../../database/prisma.service';
import { JwtAuthGuard } from '../../../common/guards';
import { ChannelAccessService } from '../../iam/channel-access/channel-access.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { IdempotencyService } from '../pipeline/idempotency.service';

describe('SPEC-023 rotas HTTP (guards reais exceto JWT, banco simulado)', () => {
  let app: any;
  let base: string;
  const note = { id: 'note', conversationId: 'conv', authorId: 'user', content: 'nota', createdAt: new Date(), updatedAt: new Date() };
  const conversation = { id: 'conv', organizationId: 'org', channelId: 'wa', contactId: 'person', isGroup: false, metadata: {}, contact: { phone: '5511999999999', email: null } };
  const prisma: any = {
    userOrganization: { findUnique: jest.fn(async ({ where }: any) => ({ id: 'membership', organizationId: where.userId_organizationId.organizationId, role: 'AGENT', organization: { name: 'Synthetic', slug: 'synthetic' } })) },
    channelAgent: { findMany: jest.fn(async ({ where }: any) => where.channel.organizationId === 'org' ? [{ channelId: 'wa' }] : []) },
    conversation: { findFirst: jest.fn(async ({ where }: any) => where.id === 'conv' && where.organizationId === 'org' ? conversation : null), update: jest.fn(async ({ data }: any) => ({ ...conversation, ...data })) },
    internalNote: { findMany: jest.fn(async () => [note]), findFirst: jest.fn(async () => note), create: jest.fn(async () => note), update: jest.fn(async ({ data }: any) => ({ ...note, ...data })), delete: jest.fn(async () => note) },
    user: { findMany: jest.fn(async () => [{ id: 'user', name: 'Autor' }]) },
    channel: { findMany: jest.fn(async () => [{ id: 'wa', name: 'WhatsApp', type: 'WHATSAPP_OFFICIAL', isActive: true }]) },
    conversationAuditLog: { create: jest.fn() },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ConversationWorkspaceController],
      providers: [ConversationWorkspaceService, ChannelAccessService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeGateway, useValue: { emitToChannel: jest.fn(), emitToConversation: jest.fn() } },
        { provide: IdempotencyService, useValue: { withLock: (_: string, fn: () => unknown) => fn() } },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx: any) => {
      const req = ctx.switchToHttp().getRequest();
      req.user = { id: 'user' };
      return req.headers.authorization === 'Bearer synthetic';
    } }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  const routes: [string, string, unknown, number][] = [
    ['PATCH', 'mute', { mode: '1h' }, 200],
    ['GET', 'notes', undefined, 200],
    ['POST', 'notes', { content: 'nota' }, 201],
    ['PATCH', 'notes/note', { content: 'editada' }, 200],
    ['DELETE', 'notes/note', undefined, 200],
    ['GET', 'send-channels', undefined, 200],
    ['POST', 'send-channels/wa/open', {}, 201],
  ];
  async function request(method: string, path: string, body: unknown, org = 'org', authorized = true) {
    return fetch(`${base}/conversations/conv/${path}`, { method, headers: { 'content-type': 'application/json', 'x-organization-id': org, ...(authorized ? { authorization: 'Bearer synthetic' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  it.each(routes)('%s %s entrega o contrato e recusa org/canal alheio', async (method, path, body, status) => {
    const response = await request(method, path, body);
    expect(response.status).toBe(status);
    const json = await response.json();
    if (path === 'mute') expect(json).toEqual({ id: 'conv', mutedUntil: expect.any(String) });
    if (method === 'GET' && path === 'notes') expect(json).toEqual([expect.objectContaining({ authorName: 'Autor', content: 'nota' })]);
    if (path.endsWith('/open')) expect(json).toEqual({ conversationId: 'conv' });
    expect((await request(method, path, body, 'other')).status).toBe(404);
    prisma.channelAgent.findMany.mockResolvedValueOnce([]);
    expect((await request(method, path, body)).status).toBe(403);
    expect((await request(method, path, body, 'org', false)).status).toBe(403);
  });
  it('valida corpos e canal alvo sem aceitar escrita arbitrária', async () => {
    expect((await request('PATCH', 'mute', { mode: 'invalid', aiEnabled: true })).status).toBe(400);
    expect((await request('POST', 'notes', {})).status).toBe(400);
    expect((await request('PATCH', 'notes/note', { content: 42 })).status).toBe(400);
    expect((await request('POST', 'send-channels/denied/open', {})).status).toBe(403);
  });
});
