import { WORKBENCH_STATUS } from './domain/workbench';
import {
  buildHarness,
  convA,
  emptyLiveCatalogStore,
  emptyWorkbenchStore,
  expectHttp,
  LIVE_CATALOG_PROFILE,
  projectA,
  projectTask,
  workbenchEnv,
} from './clickup-inbox.test-harness';

const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';

function groupConv(overrides: Record<string, unknown> = {}) {
  return convA({ isGroup: true, contact: { name: 'Grupo Holding', phone: null }, ...overrides });
}

function liveHarness(opts: {
  conv?: any;
  project?: any | null;
  store?: ReturnType<typeof emptyLiveCatalogStore>;
  env?: Record<string, string>;
} = {}) {
  const conv = opts.conv ?? groupConv();
  const project = opts.project === undefined ? null : opts.project;
  return {
    conv,
    project,
    ...buildHarness({
      env: opts.env ?? workbenchEnv(LIVE_CATALOG_PROFILE),
      conv,
      conversations: [conv],
      projects: project ? [project] : [],
      links: project ? [{ conversationId: conv.id, projectId: project.id }] : [],
      store: opts.store ?? emptyLiveCatalogStore(),
    }),
  };
}

function createPosts(fetchFn: { mock: { calls: any[] } }) {
  return fetchFn.mock.calls.filter(
    (c: any) => /\/list\/[^/]+\/task/.test(String(c[0])) && (c[1]?.method ?? 'GET') === 'POST',
  );
}

describe('SPEC-009 W1 catálogo live', () => {
  it('AC-06 GET catalog devolve árvore com homônimos e folders; sem pré-seleção no payload', async () => {
    const { service } = liveHarness();
    const out = await service.catalogWorkbench('org-a', 'conv-a');
    expect(out.catalogShortcuts.map((item: { id: string }) => item.id)).toEqual([
      'list-vendas',
      'list-holding',
      'list-consultivo',
      'list-iniciais',
    ]);
    expect(out.spaces.map((space: { id: string }) => space.id)).toEqual([
      'space-comercial',
      'space-projetos',
    ]);
    const comercial = out.spaces.find((space: { id: string }) => space.id === 'space-comercial')!;
    const projetos = out.spaces.find((space: { id: string }) => space.id === 'space-projetos')!;
    expect(comercial.lists.map((lista: { label: string }) => lista.label)).toContain('Consultivo');
    expect(projetos.lists.filter((lista: { label: string }) => lista.label === 'Consultivo').length).toBe(
      2,
    );
    expect(projetos.folders[0]!.lists.map((lista: { id: string }) => lista.id)).toEqual([
      'list-iniciais',
      'list-iniciais-live',
    ]);
    expect(out).not.toHaveProperty('selectedListId');
  });

  it('AC-07 labels dos exemplos estão no catálogo autorizado sem mapa no source', async () => {
    const { service } = liveHarness();
    const out = await service.catalogWorkbench('org-a', 'conv-a');
    const labels = [
      ...out.catalogShortcuts.map((item: { label: string }) => item.label),
      ...out.spaces.flatMap((space: { lists: Array<{ label: string }>; folders: Array<{ lists: Array<{ label: string }> }> }) => [
        ...space.lists.map((lista) => lista.label),
        ...space.folders.flatMap((folder) => folder.lists.map((lista) => lista.label)),
      ]),
    ];
    expect(labels).toEqual(
      expect.arrayContaining([
        'Consultivo',
        'Iniciais Judiciais a Distribuir',
        'Iniciais a Confeccionar',
        'Holding',
        'Processo de Vendas',
      ]),
    );
  });

  it('sem catalogSpaces devolve só atalhos e zero ClickUp', async () => {
    const { service, fetchFn } = buildHarness({
      env: workbenchEnv(),
      conv: groupConv(),
      conversations: [groupConv()],
      store: emptyWorkbenchStore(),
    });
    const out = await service.catalogWorkbench('org-a', 'conv-a');
    expect(out.spaces).toEqual([]);
    expect(out.catalogShortcuts.length).toBe(4);
    expect(fetchFn.mock.calls.length).toBe(0);
  });

  it('AC-09 listId forjado e spaceId fora da allowlist falham antes de POST ClickUp', async () => {
    const { service, fetchFn } = liveHarness();
    await expectHttp(
      service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
        listId: 'list-forjada',
        name: 'X',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(createPosts(fetchFn).length).toBe(0);

    const searchHits = fetchFn.mock.calls.length;
    await expectHttp(
      service.searchWorkbenchTasks('org-a', 'conv-a', 'Holding', 'space-pessoal'),
      422,
      'CLICKUP_INVALID_VALUE',
    );
    expect(fetchFn.mock.calls.length).toBe(searchHits);
  });

  it('AC-09 falha de um space no GET catalog não publica árvore e não POSTa', async () => {
    const store = emptyLiveCatalogStore();
    store.failCatalogSpace = 'space-projetos';
    const { service, catalog } = liveHarness({ store });
    await expect(service.catalogWorkbench('org-a', 'conv-a')).rejects.toBeTruthy();
    expect(catalog.peek('org-a')).toBeUndefined();
  });

  it('busca com spaceId só usa lists daquele space', async () => {
    const store = emptyLiveCatalogStore([
      projectTask('task-com', 'list-consultivo-comercial', { name: 'Consultivo Comercial' }),
      projectTask('task-proj', 'list-consultivo-projetos', { name: 'Consultivo Projetos' }),
    ]);
    const { service } = liveHarness({ store });
    const out = await service.searchWorkbenchTasks(
      'org-a',
      'conv-a',
      'Consultivo',
      'space-comercial',
    );
    expect(out.candidatos.map((item: { taskId: string }) => item.taskId)).toEqual(['task-com']);
  });
});

describe('SPEC-009 W2 união live + crossLinkDossier', () => {
  it('cria e vincula em lista só da árvore live', async () => {
    const { service, conv, fetchFn } = liveHarness();
    const created = await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
      listId: 'list-holding-live',
      name: 'Holding Extra',
    });
    expect(created.status).toBe(WORKBENCH_STATUS.TASK_VINCULADA);
    expect(conv.clickupTaskId).toBe(created.card.taskId);
    expect(
      createPosts(fetchFn).some((c: any) => String(c[0]).includes('/list/list-holding-live/task')),
    ).toBe(true);

    const store = emptyLiveCatalogStore([
      projectTask('task-live', 'list-consultivo-comercial', { name: 'Consultivo Comercial' }),
    ]);
    const bindH = liveHarness({ store });
    const bound = await bindH.service.bindWorkbenchTask('org-a', 'conv-a', KEY_A, {
      taskRef: 'task-live',
    });
    expect(bound.card.taskId).toBe('task-live');
    expect(bindH.conv.clickupTaskId).toBe('task-live');
  });

  it('1:1 cria em lista live (não só a principal)', async () => {
    const conv = convA();
    const { service } = liveHarness({ conv });
    const created = await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
      listId: 'list-iniciais-live',
      name: 'Inicial da Ana',
    });
    expect(created.card.taskId).toBeTruthy();
    expect(conv.clickupTaskId).toBe(created.card.taskId);
  });

  it('AC-15 sem dossiê não grava Project; default true preenche dossiê vazio', async () => {
    const sem = liveHarness({ project: null });
    await sem.service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
      listId: 'list-holding',
      name: 'Holding',
    });
    expect(sem.prisma.project.update).not.toHaveBeenCalled();

    const project = projectA();
    const com = liveHarness({ project });
    await com.service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
      listId: 'list-holding',
      name: 'Holding',
    });
    expect(project.clickupTaskId).toBe(com.conv.clickupTaskId);
  });

  it('AC-15 dossiê vazio com crossLinkDossier false não preenche', async () => {
    const project = projectA();
    const { service, conv } = liveHarness({ project });
    await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
      listId: 'list-holding',
      name: 'Holding',
      crossLinkDossier: false,
    });
    expect(conv.clickupTaskId).toBeTruthy();
    expect(project.clickupTaskId).toBeNull();
  });

  it('AC-15 dossiê divergente não overwrite sem true explícito; true troca só o dossiê', async () => {
    const project = projectA({ clickupTaskId: 'task-antiga' });
    const store = emptyLiveCatalogStore([projectTask('task-antiga', 'list-holding')]);
    const { service, conv } = liveHarness({ project, store });
    await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
      listId: 'list-consultivo',
      name: 'Consultivo',
    });
    expect(conv.clickupTaskId).toBeTruthy();
    expect(conv.clickupTaskId).not.toBe('task-antiga');
    expect(project.clickupTaskId).toBe('task-antiga');

    const other = liveHarness({
      project: projectA({ clickupTaskId: 'task-antiga' }),
      store: emptyLiveCatalogStore([projectTask('task-antiga', 'list-holding')]),
    });
    await other.service.bindWorkbenchTask('org-a', 'conv-a', KEY_A, {
      taskRef: 'task-antiga',
    });
    const switched = await other.service.createWorkbenchTask('org-a', 'conv-a', KEY_B, {
      listId: 'list-consultivo',
      name: 'Consultivo',
      confirmSwitch: true,
      crossLinkDossier: true,
    });
    expect(other.conv.clickupTaskId).toBe(switched.card.taskId);
    expect(other.project.clickupTaskId).toBe(switched.card.taskId);
    expect(other.store.tasks['task-antiga']).toBeDefined();
  });

  it('AC-15 falha do cruzamento deixa a âncora da conversa intacta', async () => {
    const project = projectA();
    const { service, conv, prisma } = liveHarness({ project });
    prisma.project.update.mockRejectedValueOnce(new Error('db down'));
    const created = await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
      listId: 'list-holding',
      name: 'Holding',
    });
    expect(conv.clickupTaskId).toBe(created.card.taskId);
    expect(project.clickupTaskId).toBeNull();
  });

  it('W3 incorporations deixa de ser 501', async () => {
    const { service } = liveHarness();
    await expectHttp(
      service.incorporateWorkbench('org-a', 'conv-a', 'not-a-uuid', {
        kind: 'comment',
        messageId: 'msg-1',
      }),
      422,
      'CLICKUP_INVALID_VALUE',
    );
  });

  it('create em atalho W0 continua válido com catalogSpaces', async () => {
    const { service, conv } = liveHarness();
    const created = await service.createWorkbenchTask('org-a', 'conv-a', KEY_A, {
      listId: 'list-holding',
      name: 'Holding',
    });
    expect(created.status).toBe(WORKBENCH_STATUS.TASK_VINCULADA);
    expect(conv.clickupTaskId).toBe(created.card.taskId);
  });
});

describe('W1 HTTP client catalogoDosSpaces', () => {
  it('não devolve árvore se um space falhar no meio', async () => {
    const store = emptyLiveCatalogStore();
    store.failCatalogSpace = 'space-projetos';
    const { http } = liveHarness({ store });
    await expect(
      http.catalogoDosSpaces(['space-comercial', 'space-projetos']),
    ).rejects.toBeTruthy();
  });
});
