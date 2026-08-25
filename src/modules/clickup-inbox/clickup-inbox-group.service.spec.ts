import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GROUP_STATUS } from './domain/grupo';
import { MemoryW2Store } from './clickup-inbox-w2.store';
import {
  buildHarness,
  convA,
  emptyGroupStore,
  emptyStore,
  expectHttp,
  groupEnv,
  GROUP_PROFILE,
  leadTask,
  mutationCalls,
  projectA,
  projectTask,
} from './clickup-inbox.test-harness';

const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';

function groupConv(overrides: Record<string, unknown> = {}) {
  return convA({ isGroup: true, contact: { name: 'Grupo Holding', phone: null }, ...overrides });
}

function groupHarness(opts: {
  project?: any | null;
  conv?: any;
  conversations?: any[];
  projects?: any[];
  links?: Array<{ conversationId: string; projectId: string }>;
  store?: ReturnType<typeof emptyGroupStore>;
  w2Store?: MemoryW2Store;
} = {}) {
  const conv = opts.conv ?? groupConv();
  const project = opts.project === undefined ? projectA() : opts.project;
  const projects = opts.projects ?? (project ? [project] : []);
  const links =
    opts.links
    ?? (project ? [{ conversationId: conv.id, projectId: project.id }] : []);
  return {
    conv,
    project,
    ...buildHarness({
      env: groupEnv(),
      conv,
      conversations: opts.conversations ?? [conv],
      projects,
      links,
      store: opts.store ?? emptyGroupStore(),
      w2Store: opts.w2Store,
    }),
  };
}

function projectCreates(fetchFn: { mock: { calls: any[] } }) {
  return fetchFn.mock.calls.filter(
    (c: any) =>
      /\/list\/list-(holding|contencioso)\/task/.test(String(c[0]))
      && (c[1]?.method ?? 'GET') === 'POST',
  );
}

describe('SPEC-008 grupo/dossiê ClickUp', () => {
  describe('AC-01 1:1 preservado e grupo sem índice de telefone', () => {
    it('1:1 continua casando por telefone mesmo com projectLists no perfil', async () => {
      const task = leadTask('task-1', '+55 11 99876-5432');
      const { service } = buildHarness({
        env: groupEnv(),
        conv: convA(),
        store: emptyGroupStore([task]),
      });
      const out = await service.resolve('org-a', 'conv-a');
      expect(out.status).toBe('unico');
      expect((out as any).card.taskId).toBe('task-1');
    });

    it('GET 1:1 em grupo devolve grupo e zero ClickUp; alias /group não usa lista de leads', async () => {
      const { service, fetchFn } = groupHarness({ project: null });
      const one = await service.resolve('org-a', 'conv-a');
      expect(one.status).toBe('grupo');
      expect(fetchFn.mock.calls.length).toBe(0);
      const group = await service.resolveGroup('org-a', 'conv-a');
      expect(group.status).toBe(GROUP_STATUS.SEM_VINCULO);
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('1:1 não entra na rota de grupo', async () => {
      const { service, fetchFn } = buildHarness({
        env: groupEnv(),
        conv: convA(),
        store: emptyGroupStore([]),
      });
      await expectHttp(service.resolveGroup('org-a', 'conv-a'), 422, 'CLICKUP_INVALID_VALUE');
      expect(fetchFn.mock.calls.length).toBe(0);
    });
  });

  describe('AC-02 sem dossiê não é mais gate', () => {
    it('mostra sem_vinculo e faz zero chamada ClickUp no resolve', async () => {
      const { service, fetchFn } = groupHarness({ project: null, store: emptyGroupStore([projectTask('t1', 'list-holding')]) });
      const out = await service.resolveGroup('org-a', 'conv-a');
      expect(out.status).toBe(GROUP_STATUS.SEM_VINCULO);
      expect(out.conversationId).toBe('conv-a');
      expect(out.dossier).toBeNull();
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('bind/search/create sem dossiê seguem no workbench', async () => {
      const store = emptyGroupStore([projectTask('abc-123', 'list-holding')]);
      const { service, conv } = groupHarness({ project: null, store });
      const search = await service.searchGroupTasks('org-a', 'conv-a', 'abc-123');
      expect(search.candidatos[0].taskId).toBe('abc-123');
      const bound = await service.bindGroupTask('org-a', 'conv-a', 'abc-123', KEY_A);
      expect(bound.card.taskId).toBe('abc-123');
      expect(conv.clickupTaskId).toBe('abc-123');
    });
  });

  describe('AC-03 âncora no dossiê', () => {
    it('duas conversas do mesmo dossiê veem a mesma task; outro dossiê não herda', async () => {
      const convB = groupConv({ id: 'conv-b' });
      const convC = groupConv({ id: 'conv-c' });
      const projA = projectA({ clickupTaskId: 'task-hold' });
      const projB = projectA({ id: 'proj-b', name: 'Outro', clickupTaskId: null });
      const store = emptyGroupStore([projectTask('task-hold', 'list-holding', { name: 'Holding Silva' })]);
      const { service } = groupHarness({
        conv: groupConv(),
        conversations: [groupConv(), convB, convC],
        projects: [projA, projB],
        links: [
          { conversationId: 'conv-a', projectId: 'proj-a' },
          { conversationId: 'conv-b', projectId: 'proj-a' },
          { conversationId: 'conv-c', projectId: 'proj-b' },
        ],
        store,
      });
      const a = await service.resolveGroup('org-a', 'conv-a');
      const b = await service.resolveGroup('org-a', 'conv-b');
      const c = await service.resolveGroup('org-a', 'conv-c');
      expect(a.status).toBe(GROUP_STATUS.SEM_VINCULO);
      expect(b.status).toBe(GROUP_STATUS.SEM_VINCULO);
      expect((a as any).dossier?.clickupTaskId).toBe('task-hold');
      expect((b as any).dossier?.clickupTaskId).toBe('task-hold');
      expect(c.status).toBe(GROUP_STATUS.SEM_VINCULO);
    });
  });

  describe('AC-04 bind válido', () => {
    it('vincula por URL, persiste no dossiê e o refresh resolve o card', async () => {
      const project = projectA();
      const store = emptyGroupStore([projectTask('abc-123', 'list-holding', { name: 'Holding Silva' })]);
      const { service, prisma } = groupHarness({ project, store });
      const bound = await service.bindGroupTask(
        'org-a',
        'conv-a',
        'https://app.clickup.com/t/abc-123',
        KEY_A,
      );
      expect(bound.status).toBe(GROUP_STATUS.TASK_VINCULADA);
      expect(bound.card.taskId).toBe('abc-123');
      expect(project.clickupTaskId).toBe('abc-123');
      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { clickupTaskId: 'abc-123' } }),
      );
      expect(prisma.project.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { clickupTaskId: 'abc-123' } }),
      );
      expect(Object.keys(prisma.project.update.mock.calls[0][0].data)).toEqual(['clickupTaskId']);
      const again = await service.resolveGroup('org-a', 'conv-a');
      expect(again.status).toBe(GROUP_STATUS.TASK_VINCULADA);
      expect((again as any).card.nome).toBe('Holding Silva');
    });
  });

  describe('AC-05 bind inválido', () => {
    it('id malformado, inexistente ou lista fora do catálogo não persiste nem muta', async () => {
      const project = projectA();
      const store = emptyGroupStore([projectTask('act-1', 'list-acts')]);
      const { service, fetchFn, prisma } = groupHarness({ project, store });
      await expectHttp(service.bindGroupTask('org-a', 'conv-a', 'não é ref!!', KEY_A), 422, 'CLICKUP_INVALID_VALUE');
      await expectHttp(service.bindGroupTask('org-a', 'conv-a', 'missing-id', KEY_A), 404, 'CLICKUP_TASK_NOT_BOUND');
      await expectHttp(service.bindGroupTask('org-a', 'conv-a', 'act-1', KEY_B), 404, 'CLICKUP_TASK_NOT_BOUND');
      expect(project.clickupTaskId).toBeNull();
      expect(prisma.project.update).not.toHaveBeenCalled();
      expect(mutationCalls(fetchFn).length).toBe(0);
    });
  });

  describe('AC-06 busca sem escolha automática', () => {
    it('N candidatos voltam todos e nenhum é gravado', async () => {
      const store = emptyGroupStore([
        projectTask('h1', 'list-holding', { name: 'Holding Alfa' }),
        projectTask('h2', 'list-holding', { name: 'Holding Beta' }),
      ]);
      const { service, prisma } = groupHarness({ store });
      const out = await service.searchGroupTasks('org-a', 'conv-a', 'Holding');
      expect(out.candidatos.map((c: any) => c.taskId).sort()).toEqual(['h1', 'h2']);
      expect(prisma.project.update).not.toHaveBeenCalled();
    });
  });

  describe('AC-07 tenant', () => {
    it('org B, conversa cruzada e 1:1 falham antes de Prisma mutável/ClickUp', async () => {
      const { service, fetchFn, prisma } = groupHarness();
      await expectHttp(service.resolveGroup('org-b', 'conv-a'), 403, 'CLICKUP_ORG_FORBIDDEN');
      await expectHttp(service.bindGroupTask('org-a', 'conv-de-b', 'abc', KEY_A), 404, 'CLICKUP_CONVERSATION_NOT_FOUND');
      expect(fetchFn.mock.calls.length).toBe(0);
      expect(prisma.project.update).not.toHaveBeenCalled();
    });
  });

  describe('AC-08 catálogo D2', () => {
    it('resolve sem âncora devolve atalhos lists ∪ projectLists', async () => {
      const { service, fetchFn } = groupHarness();
      const out = await service.resolveGroup('org-a', 'conv-a');
      expect(out.status).toBe(GROUP_STATUS.SEM_VINCULO);
      expect((out as any).catalogShortcuts.map((item: { id: string }) => item.id)).toEqual([
        'list-leads',
        'list-holding',
        'list-contencioso',
      ]);
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('source do módulo não contém IDs reais do inventário', () => {
      const inventory = readFileSync(
        resolve(join(__dirname, '../../../../.aiox/orca/clickup-board-inventory.md')),
        'utf8',
      );
      const ids = [...new Set(inventory.match(/90171\d{6,}/g) ?? [])];
      expect(ids.length).toBeGreaterThan(5);
      const root = resolve(__dirname);
      const files = walkTs(root).filter((f) => !f.includes('.spec.') && !f.includes('.test.'));
      const joined = files.map((f) => readFileSync(f, 'utf8')).join('\n');
      for (const id of ids) {
        expect(joined).not.toContain(id);
      }
    });
  });

  describe('AC-09 criar', () => {
    it('dossiê+nome+lista autorizada cria, ancora e mostra o card', async () => {
      const project = projectA();
      const { service, fetchFn, store } = groupHarness({ project, store: emptyGroupStore([]) });
      const out = await service.createGroupTask('org-a', 'conv-a', KEY_A, {
        listId: 'list-holding',
        name: 'Holding Silva',
      });
      expect(out.status).toBe(GROUP_STATUS.TASK_VINCULADA);
      expect(out.card.nome).toBe('Holding Silva');
      expect(project.clickupTaskId).toBe(out.card.taskId);
      const write = projectCreates(fetchFn)[0];
      expect(JSON.parse(String(write[1].body))).toEqual({ name: 'Holding Silva' });
      expect(store.tasks[out.card.taskId].list.id).toBe('list-holding');
    });

    it('lista forjada ou nome vazio fazem zero POST; sem dossiê ainda cria', async () => {
      const withProject = groupHarness({ store: emptyGroupStore([]) });
      await expectHttp(
        withProject.service.createGroupTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-forjada',
          name: 'Nope',
        }),
        422,
        'CLICKUP_INVALID_VALUE',
      );
      await expectHttp(
        withProject.service.createGroupTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-holding',
          name: '   ',
        }),
        422,
        'CLICKUP_INVALID_VALUE',
      );
      expect(projectCreates(withProject.fetchFn).length).toBe(0);

      const sem = groupHarness({ project: null, store: emptyGroupStore([]) });
      const created = await sem.service.createGroupTask('org-a', 'conv-a', KEY_A, {
        listId: 'list-holding',
        name: 'X',
      });
      expect(created.status).toBe(GROUP_STATUS.TASK_VINCULADA);
      expect(projectCreates(sem.fetchFn).length).toBe(1);
    });
  });

  describe('AC-10 idempotência e Redis fail-closed', () => {
    it('retry da mesma key e concorrência geram uma task', async () => {
      const project = projectA();
      const { service, fetchFn } = groupHarness({ project, store: emptyGroupStore([]) });
      const first = await service.createGroupTask('org-a', 'conv-a', KEY_A, {
        listId: 'list-holding',
        name: 'Holding Silva',
      });
      const retry = await service.createGroupTask('org-a', 'conv-a', KEY_A, {
        listId: 'list-holding',
        name: 'Holding Silva',
      });
      expect(retry.card.taskId).toBe(first.card.taskId);
      expect(projectCreates(fetchFn).length).toBe(1);

      const project2 = projectA({ id: 'proj-conc' });
      const conc = groupHarness({
        conv: groupConv({ id: 'conv-conc' }),
        project: project2,
        store: emptyGroupStore([]),
      });
      const results = await Promise.allSettled([
        conc.service.createGroupTask('org-a', 'conv-conc', KEY_A, {
          listId: 'list-holding',
          name: 'Um',
        }),
        conc.service.createGroupTask('org-a', 'conv-conc', KEY_B, {
          listId: 'list-holding',
          name: 'Dois',
        }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(ok.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason.getStatus()).toBe(409);
      expect(projectCreates(conc.fetchFn).length).toBe(1);
    });

    it('Redis indisponível falha antes do POST', async () => {
      const w2Store = new MemoryW2Store({ failReady: true });
      const { service, fetchFn } = groupHarness({ store: emptyGroupStore([]), w2Store });
      await expectHttp(
        service.createGroupTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-holding',
          name: 'X',
        }),
        503,
        'CLICKUP_STORE_UNAVAILABLE',
      );
      expect(projectCreates(fetchFn).length).toBe(0);
    });
  });

  describe('AC-11 falha após POST', () => {
    it('falha no comprovante apaga a task e não ancora', async () => {
      const project = projectA();
      const w2Store = new MemoryW2Store({ failSetReceipt: true });
      const store = emptyGroupStore([]);
      const { service } = groupHarness({ project, store, w2Store });
      await expectHttp(
        service.createGroupTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-holding',
          name: 'Holding Silva',
        }),
        503,
        'CLICKUP_STORE_UNAVAILABLE',
      );
      expect(project.clickupTaskId).toBeNull();
      expect(Object.keys(store.tasks).length).toBe(0);
    });
  });

  describe('W3 stub e binding inválido', () => {
    it('POST incorporations deixa de ser 501 e valida o DTO', async () => {
      const { service } = groupHarness();
      await expectHttp(
        service.incorporateGroup('org-a', 'conv-a', 'not-a-uuid', {
          kind: 'comment',
          messageId: 'msg-1',
        }),
        422,
        'CLICKUP_INVALID_VALUE',
      );
    });

    it('task apagada vira binding_invalido sem mutações', async () => {
      const project = projectA({ clickupTaskId: 'sumiu' });
      const { service, fetchFn } = groupHarness({ project, store: emptyGroupStore([]) });
      const out = await service.resolveGroup('org-a', 'conv-a');
      expect(out.status).toBe(GROUP_STATUS.BINDING_INVALIDO);
      expect(mutationCalls(fetchFn).length).toBe(0);
    });
  });
});

function walkTs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walkTs(full);
    return /\.ts$/.test(name) ? [full] : [];
  });
}
