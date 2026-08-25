import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ClickUpInboxWorkbenchController } from './clickup-inbox-workbench.controller';
import { MemoryW2Store } from './clickup-inbox-w2.store';
import { WORKBENCH_STATUS } from './domain/workbench';
import {
  buildHarness,
  convA,
  emptyWorkbenchStore,
  expectHttp,
  leadTask,
  leadTaskWritable,
  mutationCalls,
  projectA,
  projectTask,
  workbenchEnv,
  WORKBENCH_PROFILE,
} from './clickup-inbox.test-harness';

const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';

function groupConv(overrides: Record<string, unknown> = {}) {
  return convA({ isGroup: true, contact: { name: 'Grupo Holding', phone: null }, ...overrides });
}

function vendasTask(id: string, phone: string, extra: Record<string, unknown> = {}) {
  return leadTask(id, phone, {
    ...extra,
    list: { id: 'list-vendas', name: 'Processo de Vendas' },
  });
}

function workbenchHarness(opts: {
  conv?: any;
  conversations?: any[];
  project?: any | null;
  projects?: any[];
  links?: Array<{ conversationId: string; projectId: string }>;
  store?: ReturnType<typeof emptyWorkbenchStore>;
  w2Store?: MemoryW2Store;
  env?: Record<string, string>;
} = {}) {
  const conv = opts.conv ?? groupConv();
  const project = opts.project === undefined ? null : opts.project;
  const projects = opts.projects ?? (project ? [project] : []);
  const links =
    opts.links ?? (project ? [{ conversationId: conv.id, projectId: project.id }] : []);
  return {
    conv,
    project,
    ...buildHarness({
      env: opts.env ?? workbenchEnv(),
      conv,
      conversations: opts.conversations ?? [conv],
      projects,
      links,
      store: opts.store ?? emptyWorkbenchStore(),
      w2Store: opts.w2Store,
    }),
  };
}

function shortcutCreates(fetchFn: { mock: { calls: any[] } }) {
  return fetchFn.mock.calls.filter(
    (c: any) =>
      /\/list\/list-(holding|consultivo|iniciais|vendas)\/task/.test(String(c[0]))
      && (c[1]?.method ?? 'GET') === 'POST',
  );
}

describe('SPEC-009 W0 ClickUp workbench', () => {
  describe('AC-01/AC-05 sem gate de dossiê', () => {
    it('grupo sem dossiê resolve sem_vinculo com Vincular/Criar (catálogo) e zero ClickUp', async () => {
      const { service, fetchFn } = workbenchHarness({ project: null });
      const out = await service.resolveWorkbench('org-a', 'conv-a');
      expect(out.status).toBe(WORKBENCH_STATUS.SEM_VINCULO);
      expect(out.dossier).toBeNull();
      expect(out.phoneShortcut).toBeUndefined();
      expect(out.catalogShortcuts.map((item: { id: string }) => item.id)).toEqual([
        'list-vendas',
        'list-holding',
        'list-consultivo',
        'list-iniciais',
      ]);
      expect(out.canCreateLead).toBe(false);
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('1:1 sem telefone também devolve sem_vinculo e o catálogo', async () => {
      const conv = convA({ contact: { name: 'Ana', phone: null } });
      const { service, fetchFn } = workbenchHarness({ conv, project: null });
      const out = await service.resolveWorkbench('org-a', 'conv-a');
      expect(out.status).toBe(WORKBENCH_STATUS.SEM_VINCULO);
      expect(out.phoneShortcut?.status).toBe('fora_do_padrao');
      expect(out.catalogShortcuts.length).toBe(4);
      expect(out.canCreateLead).toBe(false);
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('dossiê presente é chip opcional e não muda as ações', async () => {
      const project = projectA();
      const { service, fetchFn } = workbenchHarness({ conv: groupConv(), project });
      const out = await service.resolveWorkbench('org-a', 'conv-a');
      expect(out.status).toBe(WORKBENCH_STATUS.SEM_VINCULO);
      expect(out.dossier).toEqual({ id: 'proj-a', name: 'Holding Silva', clickupTaskId: null });
      expect(out.catalogShortcuts.length).toBe(4);
      expect(fetchFn.mock.calls.length).toBe(0);
    });
  });

  describe('AC-02 grupo nunca casa telefone', () => {
    it('grupo com ou sem dossiê não chama o índice telefônico', async () => {
      const withDossier = workbenchHarness({ project: projectA() });
      const spyA = jest.spyOn(withDossier.match, 'resolverTelefone');
      await withDossier.service.resolveWorkbench('org-a', 'conv-a');
      expect(spyA).not.toHaveBeenCalled();

      const sem = workbenchHarness({ project: null });
      const spyB = jest.spyOn(sem.match, 'resolverTelefone');
      await sem.service.resolveWorkbench('org-a', 'conv-a');
      expect(spyB).not.toHaveBeenCalled();
    });
  });

  describe('AC-03/AC-04 atalho telefônico 1:1', () => {
    it('zero, um e N matches mantêm sem_vinculo; único é sugestão e não ancora', async () => {
      const phone = '+55 11 99876-5432';
      const zero = workbenchHarness({
        conv: convA(),
        store: emptyWorkbenchStore([]),
      });
      const sem = await zero.service.resolveWorkbench('org-a', 'conv-a');
      expect(sem.status).toBe(WORKBENCH_STATUS.SEM_VINCULO);
      expect(sem.phoneShortcut?.status).toBe('sem_card');
      expect(sem.canCreateLead).toBe(true);
      expect(zero.conv.clickupTaskId).toBeNull();

      const unicoStore = emptyWorkbenchStore([vendasTask('task-1', phone)]);
      const one = workbenchHarness({ conv: convA(), store: unicoStore });
      const unico = await one.service.resolveWorkbench('org-a', 'conv-a');
      expect(unico.status).toBe(WORKBENCH_STATUS.SEM_VINCULO);
      expect(unico.phoneShortcut?.status).toBe('unico');
      expect(unico.phoneShortcut?.card?.taskId).toBe('task-1');
      expect(one.conv.clickupTaskId).toBeNull();
      expect(one.prisma.conversation.update).not.toHaveBeenCalled();

      const nStore = emptyWorkbenchStore([
        vendasTask('a1', phone, { name: 'A' }),
        vendasTask('b2', phone, { name: 'B' }),
      ]);
      const many = workbenchHarness({ conv: convA(), store: nStore });
      const ambiguo = await many.service.resolveWorkbench('org-a', 'conv-a');
      expect(ambiguo.status).toBe(WORKBENCH_STATUS.SEM_VINCULO);
      expect(ambiguo.phoneShortcut?.status).toBe('ambiguo');
      expect(ambiguo.phoneShortcut?.candidatos?.map((c: { taskId: string }) => c.taskId).sort()).toEqual([
        'a1',
        'b2',
      ]);
      expect(many.conv.clickupTaskId).toBeNull();
    });
  });

  describe('AC-10 bind sem dossiê + lazy backfill', () => {
    it('grupo e 1:1 vinculam por URL e persistem Conversation.clickupTaskId', async () => {
      const store = emptyWorkbenchStore([
        projectTask('abc-123', 'list-holding', { name: 'Holding Silva' }),
      ]);
      const group = workbenchHarness({ conv: groupConv(), project: null, store });
      const bound = await group.service.bindWorkbenchTask('org-a', 'conv-a', KEY_A, {
        taskRef: 'https://app.clickup.com/t/abc-123',
      });
      expect(bound.status).toBe(WORKBENCH_STATUS.TASK_VINCULADA);
      expect(bound.card.taskId).toBe('abc-123');
      expect(group.conv.clickupTaskId).toBe('abc-123');
      expect(group.prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { clickupTaskId: 'abc-123' } }),
      );
      expect(group.prisma.project.update).not.toHaveBeenCalled();
      const again = await group.service.resolveWorkbench('org-a', 'conv-a');
      expect(again.status).toBe(WORKBENCH_STATUS.TASK_VINCULADA);
      expect((again as { card?: { nome: string } }).card?.nome).toBe('Holding Silva');

      const oneStore = emptyWorkbenchStore([
        projectTask('c1', 'list-consultivo', { name: 'Consultivo Ana' }),
      ]);
      const one = workbenchHarness({
        conv: convA({ contact: { name: 'Ana', phone: null } }),
        store: oneStore,
      });
      const boundOne = await one.service.bindWorkbenchTask('org-a', 'conv-a', KEY_B, {
        taskRef: 'c1',
      });
      expect(boundOne.card.taskId).toBe('c1');
      expect(one.conv.clickupTaskId).toBe('c1');
    });

    it('lazy backfill copia dossiê→conversa no primeiro GET e não o contrário', async () => {
      const project = projectA({ clickupTaskId: 'task-hold' });
      const store = emptyWorkbenchStore([
        projectTask('task-hold', 'list-holding', { name: 'Holding Silva' }),
      ]);
      const { service, conv, prisma } = workbenchHarness({
        conv: groupConv(),
        project,
        store,
      });
      const out = await service.resolveWorkbench('org-a', 'conv-a');
      expect(out.status).toBe(WORKBENCH_STATUS.TASK_VINCULADA);
      expect(conv.clickupTaskId).toBe('task-hold');
      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { clickupTaskId: 'task-hold' } }),
      );
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('duas conversas do mesmo dossiê não herdam âncora uma da outra', async () => {
      const convB = groupConv({ id: 'conv-b' });
      const { service } = workbenchHarness({
        conv: groupConv({ clickupTaskId: 'task-hold' }),
        conversations: [groupConv({ clickupTaskId: 'task-hold' }), convB],
        project: projectA({ clickupTaskId: null }),
        links: [
          { conversationId: 'conv-a', projectId: 'proj-a' },
          { conversationId: 'conv-b', projectId: 'proj-a' },
        ],
        store: emptyWorkbenchStore([projectTask('task-hold', 'list-holding')]),
      });
      const a = await service.resolveWorkbench('org-a', 'conv-a');
      const b = await service.resolveWorkbench('org-a', 'conv-b');
      expect(a.status).toBe(WORKBENCH_STATUS.TASK_VINCULADA);
      expect(b.status).toBe(WORKBENCH_STATUS.SEM_VINCULO);
    });
  });

  describe('AC-11 busca sem escolha automática', () => {
    it('N candidatos voltam todos e nenhum é gravado', async () => {
      const store = emptyWorkbenchStore([
        projectTask('h1', 'list-holding', { name: 'Holding Alfa' }),
        projectTask('h2', 'list-holding', { name: 'Holding Beta' }),
      ]);
      const { service, prisma } = workbenchHarness({ conv: groupConv(), project: null, store });
      const out = await service.searchWorkbenchTasks('org-a', 'conv-a', 'Holding');
      expect(out.candidatos.map((c: { taskId: string }) => c.taskId).sort()).toEqual(['h1', 'h2']);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });
  });

  describe('AC-12 create nas listas de atalho', () => {
    it.each([
      ['list-holding', 'Holding Silva'],
      ['list-consultivo', 'Consultivo Cliente'],
      ['list-iniciais', 'Inicial a distribuir'],
      ['list-vendas', 'Lead da conversa'],
    ])('cria na lista fixture %s', async (listId, name) => {
      const { service, fetchFn, conv, store } = workbenchHarness({
        conv: groupConv(),
        project: null,
        store: emptyWorkbenchStore([]),
      });
      const out = await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, { listId, name });
      expect(out.status).toBe(WORKBENCH_STATUS.TASK_VINCULADA);
      expect(out.card.nome).toBe(name);
      expect(conv.clickupTaskId).toBe(out.card.taskId);
      const write = shortcutCreates(fetchFn)[0];
      expect(String(write[0])).toContain(`/list/${listId}/task`);
      expect(JSON.parse(String(write[1].body))).toEqual({ name });
      expect(store.tasks[out.card.taskId].list.id).toBe(listId);
    });

    it('1:1 sem âncora também cria em Consultivo', async () => {
      const { service, conv, fetchFn } = workbenchHarness({
        conv: convA({ contact: { name: 'Ana', phone: null } }),
        store: emptyWorkbenchStore([]),
      });
      const out = await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
        listId: 'list-consultivo',
        name: 'Consultivo Ana',
      });
      expect(out.card.taskId).toBe(conv.clickupTaskId);
      expect(String(shortcutCreates(fetchFn)[0][0])).toContain('/list/list-consultivo/task');
    });

    it('nome vazio ou lista fora do catálogo fazem zero POST', async () => {
      const { service, fetchFn } = workbenchHarness({ store: emptyWorkbenchStore([]) });
      await expectHttp(
        service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-holding',
          name: '   ',
        }),
        422,
        'CLICKUP_INVALID_VALUE',
      );
      await expectHttp(
        service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-forjada',
          name: 'Nope',
        }),
        422,
        'CLICKUP_INVALID_VALUE',
      );
      expect(shortcutCreates(fetchFn).length).toBe(0);
    });
  });

  describe('AC-12b confirmSwitch', () => {
    it('já bound sem confirmSwitch é 409, zero POST e âncora intacta; com flag troca sem apagar a anterior', async () => {
      const store = emptyWorkbenchStore([
        projectTask('task-consultivo', 'list-consultivo', { name: 'Consultivo' }),
      ]);
      const conv = groupConv({ clickupTaskId: 'task-consultivo' });
      const { service, fetchFn } = workbenchHarness({ conv, store });
      await expectHttp(
        service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-iniciais',
          name: 'Inicial',
        }),
        409,
        'CLICKUP_ANCHOR_EXISTS',
      );
      expect(shortcutCreates(fetchFn).length).toBe(0);
      expect(conv.clickupTaskId).toBe('task-consultivo');
      expect(store.tasks['task-consultivo']).toBeDefined();

      const switched = await service.createWorkbenchTask('org-a', 'conv-a', KEY_B, {
        listId: 'list-iniciais',
        name: 'Inicial',
        confirmSwitch: true,
      });
      expect(store.tasks[switched.card.taskId].list.id).toBe('list-iniciais');
      expect(conv.clickupTaskId).toBe(switched.card.taskId);
      expect(store.tasks['task-consultivo']).toBeDefined();
      expect(fetchFn.mock.calls.some((c: any) => /DELETE/i.test(c[1]?.method ?? ''))).toBe(false);
    });

    it('bind da mesma task é 200; bind de outra sem confirmSwitch é 409', async () => {
      const store = emptyWorkbenchStore([
        projectTask('task-consultivo', 'list-consultivo'),
        projectTask('task-inicial', 'list-iniciais'),
      ]);
      const conv = groupConv({ clickupTaskId: 'task-consultivo' });
      const { service } = workbenchHarness({ conv, store });
      const same = await service.bindWorkbenchTask('org-a', 'conv-a', KEY_A, {
        taskRef: 'task-consultivo',
      });
      expect(same.card.taskId).toBe('task-consultivo');
      await expectHttp(
        service.bindWorkbenchTask('org-a', 'conv-a', KEY_B, { taskRef: 'task-inicial' }),
        409,
        'CLICKUP_ANCHOR_EXISTS',
      );
      expect(conv.clickupTaskId).toBe('task-consultivo');
      const switched = await service.bindWorkbenchTask('org-a', 'conv-a', KEY_B, {
        taskRef: 'task-inicial',
        confirmSwitch: true,
      });
      expect(switched.card.taskId).toBe('task-inicial');
      expect(store.tasks['task-consultivo']).toBeDefined();
    });
  });

  describe('AC-13 idempotência e Redis fail-closed', () => {
    it('retry da mesma key gera uma task; Redis down falha antes do POST', async () => {
      const { service, fetchFn } = workbenchHarness({ store: emptyWorkbenchStore([]) });
      const first = await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
        listId: 'list-holding',
        name: 'Holding Silva',
      });
      const retry = await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
        listId: 'list-holding',
        name: 'Holding Silva',
      });
      expect(retry.card.taskId).toBe(first.card.taskId);
      expect(shortcutCreates(fetchFn).length).toBe(1);

      const down = workbenchHarness({
        store: emptyWorkbenchStore([]),
        w2Store: new MemoryW2Store({ failReady: true }),
      });
      await expectHttp(
        down.service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-holding',
          name: 'X',
        }),
        503,
        'CLICKUP_STORE_UNAVAILABLE',
      );
      expect(shortcutCreates(down.fetchFn).length).toBe(0);
    });

    it('concorrência com keys diferentes: uma cria, a outra 409, um POST', async () => {
      const { service, fetchFn, conv } = workbenchHarness({ store: emptyWorkbenchStore([]) });
      const results = await Promise.allSettled([
        service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-holding',
          name: 'Um',
        }),
        service.createWorkbenchTask('org-a', 'conv-a', KEY_B, {
          listId: 'list-holding',
          name: 'Dois',
        }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(ok.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason.getStatus()).toBe(409);
      expect(shortcutCreates(fetchFn).length).toBe(1);
      expect(conv.clickupTaskId).toBe((ok[0] as PromiseFulfilledResult<any>).value.card.taskId);
    });

    it('falha no comprovante apaga a task ClickUp e não ancora', async () => {
      const store = emptyWorkbenchStore([]);
      const { service, conv } = workbenchHarness({
        store,
        w2Store: new MemoryW2Store({ failSetReceipt: true }),
      });
      await expectHttp(
        service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
          listId: 'list-holding',
          name: 'Holding Silva',
        }),
        503,
        'CLICKUP_STORE_UNAVAILABLE',
      );
      expect(conv.clickupTaskId).toBeNull();
      expect(Object.keys(store.tasks).length).toBe(0);
    });
  });

  describe('AC-14 tenant', () => {
    it('org B e conversa cruzada falham antes de ClickUp/persistência', async () => {
      const { service, fetchFn, prisma } = workbenchHarness();
      await expectHttp(service.resolveWorkbench('org-b', 'conv-a'), 403, 'CLICKUP_ORG_FORBIDDEN');
      await expectHttp(
        service.bindWorkbenchTask('org-a', 'conv-de-b', KEY_A, { taskRef: 'abc' }),
        404,
        'CLICKUP_CONVERSATION_NOT_FOUND',
      );
      expect(fetchFn.mock.calls.length).toBe(0);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });
  });

  describe('AC-20/AC-23 prepareBound unificado e mutação após bind', () => {
    it('após bind sem dossiê, PATCH de campo gravável confirma; complexo faz zero escrita', async () => {
      const task = leadTaskWritable('task-c', '+55 11 99876-5432');
      task.list = { id: 'list-consultivo', name: 'Consultivo' };
      const store = emptyWorkbenchStore([task]);
      const conv = groupConv();
      const { service, fetchFn } = workbenchHarness({ conv, store });
      await service.bindWorkbenchTask('org-a', 'conv-a', KEY_A, { taskRef: 'task-c' });
      const patched = await service.patchField('org-a', 'conv-a', 'task-c', 'field-short', 'Novo');
      expect(patched.ok).toBe(true);
      await expectHttp(
        service.patchField('org-a', 'conv-a', 'task-c', 'field-users', 'x'),
        422,
        'CLICKUP_INVALID_VALUE',
      );
      const writes = mutationCalls(fetchFn).filter((c: any) => String(c[0]).includes('/field/'));
      expect(writes.length).toBe(1);
    });

    it('1:1 phone match continua editável sem bind; dossiê sozinho não autoriza mutação', async () => {
      const phone = '+55 11 99876-5432';
      const task = leadTaskWritable('task-1', phone);
      task.list = { id: 'list-vendas', name: 'Processo de Vendas' };
      const one = workbenchHarness({
        conv: convA(),
        store: emptyWorkbenchStore([task]),
      });
      const patched = await one.service.patchField('org-a', 'conv-a', 'task-1', 'field-short', 'X');
      expect(patched.ok).toBe(true);
      expect(one.conv.clickupTaskId).toBeNull();

      const group = workbenchHarness({
        conv: groupConv(),
        project: projectA({ clickupTaskId: 'task-hold' }),
        store: emptyWorkbenchStore([projectTask('task-hold', 'list-holding')]),
      });
      group.conv.clickupTaskId = null;
      await expectHttp(
        group.service.patchField('org-a', 'conv-a', 'task-hold', 'field-short', 'X'),
        404,
        'CLICKUP_TASK_NOT_BOUND',
      );
    });
  });

  describe('AC-16 W3 stub e binding inválido', () => {
    it('POST incorporations é 501', async () => {
      const { service } = workbenchHarness();
      const controller = new ClickUpInboxWorkbenchController(service);
      await expectHttp(controller.incorporate(), 501, 'CLICKUP_INCORPORATE_NOT_READY');
    });

    it('task apagada vira binding_invalido sem mutações', async () => {
      const conv = groupConv({ clickupTaskId: 'sumiu' });
      const { service, fetchFn } = workbenchHarness({ conv, store: emptyWorkbenchStore([]) });
      const out = await service.resolveWorkbench('org-a', 'conv-a');
      expect(out.status).toBe(WORKBENCH_STATUS.BINDING_INVALIDO);
      expect(mutationCalls(fetchFn).length).toBe(0);
    });
  });

  describe('AC-21 varredura', () => {
    it('módulo não contém Hoppe/Bravy/sinkra nem IDs reais do inventário', () => {
      const inventory = readFileSync(
        resolve(join(__dirname, '../../../../.aiox/orca/clickup-board-inventory.md')),
        'utf8',
      );
      const ids = [...new Set(inventory.match(/90171\d{6,}/g) ?? [])];
      expect(ids.length).toBeGreaterThan(5);
      const root = resolve(__dirname);
      const files = walkTs(root).filter((f) => !f.includes('.spec.') && !f.includes('.test.'));
      const joined = files.map((f) => readFileSync(f, 'utf8')).join('\n');
      for (const id of ids) expect(joined).not.toContain(id);
      expect(joined).not.toMatch(/hoppe/i);
      expect(joined).not.toMatch(/bravy/i);
      expect(joined).not.toMatch(/sinkra/i);
      expect(joined).not.toMatch(/sem_dossie/);
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
