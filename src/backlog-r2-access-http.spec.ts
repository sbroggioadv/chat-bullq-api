/* QA backlog-1104 (fora da worktree): N-r2-7 pela rota HTTP real.
   Controller, OrgGuard, RolesGuard, ChannelAccessService, decorator e ProjectsService reais; Prisma simulado; só o JWT é trocado
   por um guarda que põe request.user. Servidor local em porta efêmera (127.0.0.1), sem banco, sem Redis, sem rede externa.
   Mesma sonda em 0c6d7a5 (linha de base) e 545fd99. Nomes sintéticos. */
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ProjectsController } from './modules/projects/projects.controller';
import { ProjectsService } from './modules/projects/projects.service';
import { PrismaService } from './database/prisma.service';
import { ChannelAccessService } from './modules/iam/channel-access/channel-access.service';
import { JwtAuthGuard } from './common/guards';
import { EmailService } from './modules/email/email.service';

type Cfg = { role: 'AGENT' | 'ADMIN' | 'OWNER'; grants: string[]; privateChannels?: { id: string; grantedTo?: boolean }[]; linked?: boolean; legacy?: boolean; convOrg?: string };

async function boot(cfg: Cfg) {
  const writes: string[] = [];
  const conv = { id: 'conv1', organizationId: cfg.convOrg ?? 'org1', isGroup: true, channelId: 'ch1', contact: { name: 'Grupo Sintético', channels: [{ channelId: 'ch1', externalId: '123-456@g.us' }] } };
  const prisma: any = {
    userOrganization: { findUnique: jest.fn(async () => ({ id: 'uo1', organizationId: 'org1', role: cfg.role, organization: { name: 'Org Sintética', slug: 'org-sintetica' } })) },
    channelAgent: { findMany: jest.fn(async () => cfg.grants.map((channelId) => ({ channelId }))) },
    channel: {
      count: jest.fn(async () => (cfg.privateChannels ?? []).length),
      findMany: jest.fn(async () => [{ id: 'ch1' }, { id: 'ch2' }].filter((c) => { const p = (cfg.privateChannels ?? []).find((x) => x.id === c.id); return !p || p.grantedTo; })),
    },
    conversation: { findFirst: jest.fn(async ({ where }: any) => (where.id === conv.id && where.organizationId === conv.organizationId ? conv : null)) },
    projectConversation: {
      findFirst: jest.fn(async () => (cfg.linked ? { projectId: 'p-linked', conversationId: 'conv1' } : null)),
      upsert: jest.fn(async () => { writes.push('projectConversation.upsert'); return {}; }),
    },
    project: {
      findFirst: jest.fn(async () => (cfg.legacy ? { id: 'p-legacy', groupJid: '123-456@g.us' } : null)),
      findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, metadata: {} })),
      create: jest.fn(async () => { writes.push('project.create'); return { id: 'p-new' }; }),
      update: jest.fn(async () => { writes.push('project.update'); return {}; }),
    },
  };
  const mod = await Test.createTestingModule({
    controllers: [ProjectsController],
    providers: [ProjectsService, ChannelAccessService, { provide: PrismaService, useValue: prisma }, { provide: EmailService, useValue: {} }],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: (ctx: any) => { ctx.switchToHttp().getRequest().user = { id: 'u1' }; return true; } })
    .compile();
  const app: INestApplication = mod.createNestApplication({ logger: false });
  const svc = app.get(ProjectsService);
  jest.spyOn(svc, 'toDetail').mockImplementation((p: any) => ({ id: p.id, exists: true } as any));
  jest.spyOn(svc, 'getById').mockImplementation(async (_o: string, id: string) => ({ id, exists: true } as any));
  const linkSpy = jest.spyOn(svc, 'linkConversation').mockImplementation(async () => { writes.push('linkConversation'); return {} as any; });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const req = async (method: string, body?: any) => {
    const r = await fetch(`${url.replace('[::1]', '127.0.0.1')}/projects/by-conversation/conv1`, { method, headers: { 'x-organization-id': 'org1', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { app, req, writes, prisma, linkSpy };
}

const cases: [string, Cfg, string, any, number, string[]][] = [
  ['AGENT com acesso ao canal: GET de grupo legado', { role: 'AGENT', grants: ['ch1'], legacy: true }, 'GET', undefined, 200, ['projectConversation.upsert']],
  ['AGENT com acesso ao canal: GET de conversa já ligada', { role: 'AGENT', grants: ['ch1'], linked: true }, 'GET', undefined, 200, []],
  ['AGENT com acesso ao canal: GET sem projeto', { role: 'AGENT', grants: ['ch1'] }, 'GET', undefined, 200, []],
  ['AGENT com acesso ao canal: PUT "Subir" cria projeto e liga', { role: 'AGENT', grants: ['ch1'] }, 'PUT', { name: 'Projeto Sintético', metadata: { kind: 'MENTORSHIP' } }, 200, ['project.create', 'linkConversation', 'project.update']],
  ['AGENT com acesso ao canal: PUT em projeto já ligado atualiza', { role: 'AGENT', grants: ['ch1'], linked: true }, 'PUT', { name: 'Renomeado' }, 200, ['project.update']],
  ['AGENT com acesso ao canal: PUT em grupo legado liga e atualiza', { role: 'AGENT', grants: ['ch1'], legacy: true }, 'PUT', { name: 'Renomeado' }, 200, ['projectConversation.upsert', 'project.update']],
  ['OWNER sem canal privado (ALL): GET', { role: 'OWNER', grants: [], legacy: true }, 'GET', undefined, 200, ['projectConversation.upsert']],
  ['ADMIN sem canal privado (ALL): PUT', { role: 'ADMIN', grants: [] }, 'PUT', { name: 'Projeto Sintético' }, 200, ['project.create', 'linkConversation']],
  ['OWNER com o canal privado concedido: GET', { role: 'OWNER', grants: [], privateChannels: [{ id: 'ch1', grantedTo: true }], legacy: true }, 'GET', undefined, 200, ['projectConversation.upsert']],
  ['AGENT só com outro canal: GET de grupo legado', { role: 'AGENT', grants: ['ch2'], legacy: true }, 'GET', undefined, 403, []],
  ['AGENT sem canal nenhum: GET', { role: 'AGENT', grants: [], legacy: true }, 'GET', undefined, 403, []],
  ['AGENT só com outro canal: PUT sem projeto', { role: 'AGENT', grants: ['ch2'] }, 'PUT', { name: 'Intruso', metadata: { kind: 'MENTORSHIP' } }, 403, []],
  ['AGENT só com outro canal: PUT em grupo legado', { role: 'AGENT', grants: ['ch2'], legacy: true }, 'PUT', { name: 'Intruso' }, 403, []],
  ['AGENT só com outro canal: PUT em projeto já ligado', { role: 'AGENT', grants: ['ch2'], linked: true }, 'PUT', { name: 'Intruso' }, 403, []],
  ['OWNER com o canal privado SEM concessão: GET', { role: 'OWNER', grants: [], privateChannels: [{ id: 'ch1' }], legacy: true }, 'GET', undefined, 403, []],
  ['OWNER com o canal privado SEM concessão: PUT', { role: 'OWNER', grants: [], privateChannels: [{ id: 'ch1' }] }, 'PUT', { name: 'Intruso' }, 403, []],
  ['AGENT só com outro canal: DELETE (referência já corrigida)', { role: 'AGENT', grants: ['ch2'], legacy: true }, 'DELETE', undefined, 403, []],
  ['conversa de outra organização: GET continua 404', { role: 'OWNER', grants: [], convOrg: 'org2' }, 'GET', undefined, 404, []],
];

describe('N-r2-7 pela rota HTTP real', () => {
  it.each(cases)('%s', async (_name, cfg, method, body, status, writes) => {
    const w = await boot(cfg);
    if (method === 'DELETE') w.prisma.$transaction = jest.fn(async (fn: any) => fn(w.prisma));
    try {
      const r = await w.req(method, body);
      expect({ status: r.status, writes: w.writes }).toEqual({ status, writes });
    } finally {
      await w.app.close();
    }
  });
});
