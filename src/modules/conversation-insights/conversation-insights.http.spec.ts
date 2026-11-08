import { Test } from '@nestjs/testing';
import { INestApplication, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AddressInfo } from 'net';
import { ConversationInsightsController } from './conversation-insights.controller';
import { ConversationInsightsService } from './conversation-insights.service';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';

describe('Conversation insights HTTP routes', () => {
  let app: INestApplication;
  let base: string;
  const db = { conversation: { findFirst: jest.fn() }, message: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() } };
  beforeAll(async () => {
    const service = new ConversationInsightsService(db as never, new ChannelAccessService(db as never), { conversationMeetings: async () => ({ connected: false, items: [] }) } as never, {} as never, {} as never);
    const module = await Test.createTestingModule({ controllers: [ConversationInsightsController], providers: [{ provide: ConversationInsightsService, useValue: service }] })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest();
        if (!req.headers.authorization) throw new UnauthorizedException();
        req.organization = { id: req.headers['x-test-org'] || 'org' };
        req.accessibleChannelIds = new Set([req.headers['x-test-channel'] || 'ch']);
        return true;
      } }).overrideGuard(OrgGuard).useValue({ canActivate: () => true }).overrideGuard(RolesGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1'); base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    db.conversation.findFirst.mockImplementation(async ({ where }) => where.organizationId === 'org' ? { id: 'c1', channelId: 'ch', metadata: {} } : null);
    db.message.findMany.mockResolvedValue([]); db.message.findFirst.mockResolvedValue(null); db.message.count.mockResolvedValue(0);
  });
  afterAll(async () => app.close());
  const paths = ['/messages/search?q=ab', '/messages/around/m1', '/attachments', '/meetings', '/summary'];
  it.each(paths)('rejects unauthenticated GET %s', async path => {
    expect((await fetch(`${base}/conversations/c1${path}`)).status).toBe(401);
  });
  it.each(paths)('rejects other org and channel on GET %s', async path => {
    expect((await fetch(`${base}/conversations/c1${path}`, { headers: { authorization: 'test', 'x-test-org': 'other' } })).status).toBe(404);
    expect((await fetch(`${base}/conversations/c1${path}`, { headers: { authorization: 'test', 'x-test-channel': 'other' } })).status).toBe(403);
  });
  it('exposes search, attachment, meeting and summary empty contracts', async () => {
    const headers = { authorization: 'test' };
    expect(await (await fetch(`${base}/conversations/c1/messages/search?q=ab`, { headers })).json()).toEqual({ items: [], nextCursor: null });
    expect(await (await fetch(`${base}/conversations/c1/attachments`, { headers })).json()).toEqual({ items: [], nextCursor: null });
    expect(await (await fetch(`${base}/conversations/c1/meetings`, { headers })).json()).toEqual({ connected: false, items: [] });
    const summary = await fetch(`${base}/conversations/c1/summary`, { headers }); expect(summary.status).toBe(200); expect(await summary.json()).toBeNull();
  });
  it('validates query and body at the HTTP boundary', async () => {
    const headers = { authorization: 'test', 'content-type': 'application/json' };
    expect((await fetch(`${base}/conversations/c1/messages/search?q=a`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/conversations/c1/attachments?limit=51`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/conversations/c1/summary`, { method: 'POST', headers, body: '{"force":"yes"}' })).status).toBe(400);
  });
});
