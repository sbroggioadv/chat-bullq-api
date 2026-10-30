import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';
import { getQueueToken } from '@nestjs/bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { JwtStrategy } from '../../auth/jwt.strategy';
import { ChannelAccessService } from '../../iam/channel-access/channel-access.service';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import { PendingActionController } from './pending-action.controller';
import { PendingActionService } from './pending-action.service';
import { PendingActionStorage } from './pending-action.storage';
import { PENDING_ACTION_EXECUTOR_QUEUE } from './queue-names';
import { EvalsController } from '../evals/evals.controller';
import { EvalRunnerService } from '../evals/runner.service';
import { EvalReporterService } from '../evals/reporter.service';

describe('HTTP: guards e escopo', () => {
  let app: INestApplication;
  let base: string;
  let role = 'AGENT';
  let channels: 'ALL' | Set<string> = new Set(['canal-a']);
  const queue = { add: jest.fn() };
  const action = { id: 'p', agentRunId: 'run', agentId: 'agent', conversationId: 'conv', toolName: 'tool', args: {}, preview: {}, status: 'PENDING', expiresAt: new Date(Date.now() + 600000), createdAt: new Date(), approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null, rejectedReason: null, executionResult: null };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u', email: 'u@example.test', name: 'U', isActive: true }) },
    userOrganization: { findUnique: jest.fn(async () => ({ id: 'm', organizationId: 'org-a', role, organization: { name: 'A', slug: 'a' } })) },
    conversation: { findFirst: jest.fn(async ({ where }: any) => where.id === 'conv' && where.organizationId === 'org-a' && (!where.channelId || where.channelId.in.includes('canal-a')) ? { id: 'conv' } : null) },
    aiPendingAction: {
      findFirst: jest.fn(async ({ where }: any) => where.conversation.organizationId === 'org-a' && (!where.conversation.channelId || where.conversation.channelId.in.includes('canal-a')) && where.id === 'p' ? action : null),
      findMany: jest.fn(async ({ where }: any) => where.conversation.organizationId === 'org-a' && (!where.conversationId || where.conversationId === 'conv') && (!where.conversation.channelId || where.conversation.channelId.in.includes('canal-a')) ? [action] : []),
      upsert: jest.fn(),
    },
    aiAgent: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const token = sign({ sub: 'u', email: 'u@example.test' }, 'synthetic-test-secret');
  const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'x-organization-id': 'org-a', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [PendingActionController, EvalsController], providers: [PendingActionService, PendingActionStorage, JwtStrategy, JwtAuthGuard, OrgGuard, RolesGuard, { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: { get: () => 'synthetic-test-secret' } }, { provide: ChannelAccessService, useValue: { getAccessibleChannelIds: async () => channels } }, { provide: getQueueToken(PENDING_ACTION_EXECUTOR_QUEUE), useValue: queue }, { provide: EvalRunnerService, useValue: {} }, { provide: EvalReporterService, useValue: {} }] }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await app.close(); });
  it('isola as quatro rotas de ações e evals de outra organização', async () => {
    role = 'ADMIN'; channels = 'ALL';
    const outside = await request('/pending-actions?conversationId=outra');
    expect(outside.status).toBe(404);
    expect((await request('/pending-actions')).status).toBe(200);
    const listWhere = prisma.aiPendingAction.findMany.mock.calls.at(-1)?.[0].where;
    expect(listWhere.conversation.organizationId).toBe('org-a');
    for (const [path, method, body] of [['/pending-actions/outra', 'GET', undefined], ['/pending-actions/outra/approve', 'POST', {}], ['/pending-actions/outra/reject', 'POST', { reason: 'não' }], ['/agents/outra/evals/run', 'POST', {}]] as const) {
      expect((await request(path, method, body)).status).toBe(404);
    }
  });
  it('nega canal sem acesso e evals para AGENT', async () => {
    role = 'AGENT'; channels = new Set();
    expect((await request('/pending-actions/p')).status).toBe(404);
    expect(await (await request('/pending-actions')).json()).toEqual([]);
    expect((await request('/agents/alvo/evals/run', 'POST', {})).status).toBe(403);
  });
  it('aprovação autorizada continua enfileirando', async () => {
    role = 'AGENT'; channels = new Set(['canal-a']);
    expect((await request('/pending-actions/p/approve', 'POST', {})).status).toBe(201);
    expect(queue.add).toHaveBeenCalled();
  });
});
