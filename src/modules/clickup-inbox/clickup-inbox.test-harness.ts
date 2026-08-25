import { ConfigService } from '@nestjs/config';
import { ClickUpInboxConfigService } from './clickup-inbox-config.service';
import { ClickUpInboxHttpClient } from './clickup-inbox-http.client';
import { ClickUpInboxService } from './clickup-inbox.service';
import { MemoryW2Store, type ClickUpW2Store } from './clickup-inbox-w2.store';
import { ClickUpMatchService } from './clickup-match.service';
import {
  MemoryAtividadeKv,
  limparRecuperacoesAtividade,
  type AtividadeKv,
} from './domain/criacao-atividade';

export const TEST_PROFILE = {
  lists: [{ id: 'list-leads', label: 'Leads', primary: true }],
  whatsappFieldId: 'field-wa',
  blockedFieldIds: ['field-blocked'],
  tag: null as string | null,
  activities: { listId: 'list-acts', relationFieldId: 'field-rel' },
};

export const DROP_OPTIONS = [
  { id: 'opt-novo', name: 'Novo', orderindex: 0 },
  { id: 'opt-qualif', name: 'Qualificado', orderindex: 1 },
];

export const LABEL_OPTIONS = [
  { id: 'lab-a', name: 'A' },
  { id: 'lab-b', name: 'B' },
];

export const LEAD_FIELDS = [
  { id: 'field-wa', name: 'WhatsApp', type: 'phone' },
  { id: 'field-blocked', name: 'Bloqueado', type: 'text' },
  { id: 'field-drop', name: 'Etapa lead', type: 'drop_down', type_config: { options: DROP_OPTIONS } },
  { id: 'field-labels', name: 'Tags', type: 'labels', type_config: { options: LABEL_OPTIONS } },
  { id: 'field-date', name: 'Data', type: 'date' },
  { id: 'field-currency', name: 'Valor', type: 'currency' },
  { id: 'field-email', name: 'E-mail', type: 'email' },
  { id: 'field-phone', name: 'Fone', type: 'phone' },
  { id: 'field-url', name: 'URL', type: 'url' },
  { id: 'field-short', name: 'Curto', type: 'short_text' },
  { id: 'field-text', name: 'Texto', type: 'text' },
  { id: 'field-users', name: 'Users', type: 'users' },
  { id: 'field-rel-ro', name: 'Rel', type: 'list_relationship' },
  { id: 'field-check', name: 'Check', type: 'checkbox' },
  { id: 'field-number', name: 'Número', type: 'number' },
  { id: 'field-mystery', name: '??', type: 'mystery_type' },
];

export function testEnv(
  org = 'org-a',
  profile: Record<string, unknown> = TEST_PROFILE,
): Record<string, string> {
  return {
    CLICKUP_API_KEY: 'pk_test_not_a_real_key',
    CLICKUP_TEAM_ID: 'team-test',
    CLICKUP_ORGANIZATION_ID: org,
    CLICKUP_PROFILE_JSON: JSON.stringify(profile),
  };
}

export function leadTask(id: string, phone: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Lead ${id}`,
    url: `https://app.clickup.test/t/${id}`,
    list: { id: 'list-leads', name: 'Leads' },
    status: { status: 'novo', type: 'open' },
    custom_fields: [{ id: 'field-wa', value: phone }],
    tags: [],
    ...extra,
  };
}

export function leadTaskWritable(id: string, phone: string) {
  return leadTask(id, phone, {
    custom_fields: LEAD_FIELDS.map((campo) => ({
      id: campo.id,
      value: campo.id === 'field-wa' ? phone : campo.id === 'field-drop' ? 0 : campo.id === 'field-labels' ? [] : null,
    })),
  });
}

export type CuStore = {
  listsInTeam: string[];
  tasks: Record<string, any>;
  listTasks: Record<string, string[]>;
  comments: Record<string, Array<{ id: string; comment_text: string }>>;
  failPages?: boolean;
  statusCode?: number;
  ignoreFieldWrites?: boolean;
  fieldsByList?: Record<string, any[]>;
  relationListId?: string;
  failDelete?: boolean;
};

export function emptyStore(tasks: any[] = []): CuStore {
  const map: Record<string, any> = {};
  for (const task of tasks) map[task.id] = structuredClone(task);
  return {
    listsInTeam: ['list-leads', 'list-acts'],
    tasks: map,
    listTasks: {
      'list-leads': tasks.filter((t) => t.list?.id === 'list-leads').map((t) => t.id),
      'list-acts': tasks.filter((t) => t.list?.id === 'list-acts').map((t) => t.id),
    },
    comments: {},
  };
}

export function createClickUpFetch(store: CuStore) {
  const clickupFetch = jest.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/api/v2', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (store.statusCode) {
      return { ok: false, status: store.statusCode, json: async () => ({ err: 'nope' }) };
    }

    if (path === '/user' && method === 'GET') {
      return ok({ user: { id: 'u1', username: 'tester' } });
    }
    if (path === '/team' && method === 'GET') {
      return ok({ teams: [{ id: 'team-test', name: 'Sbroggioadv-test' }] });
    }
    if (path === '/team/team-test/space' && method === 'GET') {
      return ok({ spaces: [{ id: 'space-1', name: 'Espaço' }] });
    }
    if (path === '/space/space-1/folder' && method === 'GET') {
      return ok({ folders: [] });
    }
    if (path === '/space/space-1/list' && method === 'GET') {
      return ok({
        lists: store.listsInTeam.map((id) => ({ id, name: id, task_count: 0 })),
      });
    }

    if (path === '/team/team-test/task' && method === 'GET') {
      const listIds = parsed.searchParams.getAll('list_ids[]');
      const allow = new Set(listIds);
      const tasks = Object.values(store.tasks).filter((task: any) => {
        if (allow.size === 0) return true;
        return allow.has(String(task.list?.id));
      });
      return ok({ tasks, last_page: true });
    }

    const listGet = path.match(/^\/list\/([^/]+)$/);
    if (listGet && method === 'GET') {
      const listId = listGet[1];
      return ok({
        id: listId,
        name: listId === 'list-acts' ? 'Atividades' : 'Leads',
        statuses: [
          { status: 'novo', type: 'open' },
          { status: 'andamento', type: 'custom' },
          { status: 'encerrada', type: 'closed' },
        ],
      });
    }

    const listFields = path.match(/^\/list\/([^/]+)\/field$/);
    if (listFields && method === 'GET') {
      const listId = listFields[1];
      if (store.fieldsByList?.[listId]) {
        return ok({ fields: store.fieldsByList[listId] });
      }
      if (listId === 'list-acts') {
        return ok({
          fields: [
            {
              id: 'field-rel',
              type: 'list_relationship',
              type_config: { list_id: store.relationListId ?? 'list-leads' },
              applied_objects: [{ object_type: 19, object_id: 0 }],
            },
          ],
        });
      }
      return ok({ fields: LEAD_FIELDS });
    }

    const listTasks = path.match(/^\/list\/([^/]+)\/task$/);
    if (listTasks && method === 'GET') {
      const listId = listTasks[1];
      const page = Number(parsed.searchParams.get('page') ?? 0);
      if (method === 'GET') {
        if (store.failPages && page > 0) {
          const ids = store.listTasks[listId] ?? [];
          return ok({ tasks: ids.map((id) => store.tasks[id]) });
        }
        if (page > 0) return ok({ tasks: [] });
        const ids = store.listTasks[listId] ?? [];
        return ok({ tasks: ids.map((id) => store.tasks[id]) });
      }
    }

    if (listTasks && method === 'POST') {
      const listId = listTasks[1];
      if (listId === 'list-acts') {
        const id = `act-${Object.keys(store.tasks).length + 1}`;
        store.tasks[id] = {
          id,
          name: body.name,
          list: { id: listId, name: 'Atividades' },
          status: { status: 'novo', type: 'open' },
          custom_fields: [
            {
              id: 'field-rel',
              value: body.custom_fields?.[0]?.value?.add ?? [],
            },
          ],
        };
        store.listTasks[listId] = [...(store.listTasks[listId] ?? []), id];
        return ok({ id });
      }
      const id = `task-new-${Object.keys(store.tasks).length + 1}`;
      store.tasks[id] = {
        id,
        name: body.name,
        url: `https://app.clickup.test/t/${id}`,
        list: { id: listId, name: listId === 'list-leads' ? 'Leads' : listId },
        status: { status: 'novo', type: 'open' },
        custom_fields: (body.custom_fields ?? []).map((campo: { id: string; value: unknown }) => ({
          id: campo.id,
          value: campo.value,
        })),
      };
      store.listTasks[listId] = [...(store.listTasks[listId] ?? []), id];
      return ok({ id });
    }

    const taskGet = path.match(/^\/task\/([^/]+)$/);
    if (taskGet && method === 'GET') {
      const task = store.tasks[taskGet[1]];
      if (!task) return { ok: false, status: 404, json: async () => ({}) };
      return ok(task);
    }
    if (taskGet && method === 'PUT') {
      const task = store.tasks[taskGet[1]];
      if (body?.status) {
        const type = body.status === 'encerrada' ? 'closed' : 'custom';
        task.status = { status: body.status, type };
      }
      return ok(task);
    }
    if (taskGet && method === 'DELETE') {
      if (store.failDelete) return { ok: false, status: 500, json: async () => ({}) };
      const deletedId = taskGet[1];
      delete store.tasks[deletedId];
      for (const listId of Object.keys(store.listTasks)) {
        store.listTasks[listId] = store.listTasks[listId].filter((id) => id !== deletedId);
      }
      return ok({});
    }

    const fieldPath = path.match(/^\/task\/([^/]+)\/field\/([^/]+)$/);
    if (fieldPath && method === 'POST') {
      if (!store.ignoreFieldWrites) {
        const task = store.tasks[fieldPath[1]];
        const fieldId = fieldPath[2];
        const existing = (task.custom_fields ?? []).find((c: any) => c.id === fieldId);
        if (existing) existing.value = body.value;
        else task.custom_fields.push({ id: fieldId, value: body.value });
      }
      return ok({});
    }

    const commentPath = path.match(/^\/task\/([^/]+)\/comment$/);
    if (commentPath && method === 'GET') {
      return ok({ comments: store.comments[commentPath[1]] ?? [] });
    }
    if (commentPath && method === 'POST') {
      const id = `cmt-${(store.comments[commentPath[1]] ?? []).length + 1}`;
      const row = { id, comment_text: body.comment_text, user: { username: 'tester' } };
      store.comments[commentPath[1]] = [...(store.comments[commentPath[1]] ?? []), row];
      return ok({ id });
    }

    return { ok: false, status: 404, json: async () => ({}) };
  });
  return clickupFetch;
}

function ok(corpo: unknown) {
  return { ok: true, status: 200, json: async () => corpo };
}

export function makePrisma(
  conv: any,
  user: any = { name: 'Ana', email: 'ana@test' },
  extra: {
    conversations?: any[];
    projects?: any[];
    links?: Array<{ conversationId: string; projectId: string }>;
  } = {},
) {
  const conversations = extra.conversations ?? (conv ? [conv] : []);
  const projects = extra.projects ?? [];
  const links = extra.links ?? [];
  return {
    conversation: {
      findFirst: jest.fn(async ({ where }: any) => {
        const found = conversations.find(
          (row) =>
            row
            && row.id === where.id
            && row.organizationId === where.organizationId
            && row.deletedAt == null,
        );
        if (!found) return null;
        return {
          id: found.id,
          isGroup: found.isGroup,
          clickupTaskId: found.clickupTaskId ?? null,
          contact: found.contact,
        };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = conversations.find((item) => item.id === where.id);
        if (!row) throw new Error('conversation not found');
        Object.assign(row, data);
        return row;
      }),
    },
    user: {
      findUnique: jest.fn(async () => user),
    },
    projectConversation: {
      findFirst: jest.fn(async ({ where }: any) => {
        const link = links.find((row) => row.conversationId === where.conversationId);
        if (!link) return null;
        const project = projects.find((row) => row.id === link.projectId);
        if (!project || project.deletedAt) return null;
        const org = where.project?.organizationId;
        if (org && project.organizationId !== org) return null;
        return { conversationId: link.conversationId, projectId: link.projectId, project };
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const projectId = where?.projectId;
        return links
          .filter((row) => !projectId || row.projectId === projectId)
          .filter((row) => {
            const sibling = conversations.find((item) => item.id === row.conversationId);
            return Boolean(sibling && sibling.deletedAt == null);
          })
          .map((row) => ({ conversationId: row.conversationId, projectId: row.projectId }));
      }),
    },
    project: {
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          projects.find(
            (row) =>
              row.id === where.id
              && row.organizationId === where.organizationId
              && !row.deletedAt,
          ) ?? null
        );
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = projects.find((item) => item.id === where.id);
        if (!row) throw new Error('project not found');
        if (where.organizationId && row.organizationId !== where.organizationId) {
          throw new Error('project org mismatch');
        }
        Object.assign(row, data);
        return row;
      }),
    },
  };
}

export function buildHarness(opts: {
  env?: Record<string, string>;
  conv?: any;
  store?: CuStore;
  fetchFn?: jest.Mock;
  atividadeKv?: AtividadeKv;
  w2Store?: ClickUpW2Store;
  projects?: any[];
  links?: Array<{ conversationId: string; projectId: string }>;
  conversations?: any[];
}) {
  limparRecuperacoesAtividade();
  const env = opts.env ?? testEnv();
  const store = opts.store ?? emptyStore();
  const fetchFn = opts.fetchFn ?? createClickUpFetch(store);
  const config = new ClickUpInboxConfigService({
    get: (k: string) => env[k],
  } as ConfigService);
  const http = new ClickUpInboxHttpClient(config, fetchFn as any);
  const match = new ClickUpMatchService(config, http);
  const prisma = makePrisma(opts.conv, undefined, {
    conversations: opts.conversations,
    projects: opts.projects,
    links: opts.links,
  });
  const atividadeKv = opts.atividadeKv ?? new MemoryAtividadeKv();
  const w2Store = opts.w2Store ?? new MemoryW2Store();
  const service = new ClickUpInboxService(
    prisma as any,
    config,
    http,
    match,
    atividadeKv,
    w2Store,
  );
  return { service, config, http, match, prisma, fetchFn, store, atividadeKv, w2Store };
}

export function mutationCalls(fetchFn: jest.Mock) {
  return fetchFn.mock.calls.filter((c: any) => {
    const method = (c[1]?.method ?? 'GET').toUpperCase();
    return method !== 'GET';
  });
}

export function convA(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-a',
    organizationId: 'org-a',
    isGroup: false,
    deletedAt: null,
    clickupTaskId: null as string | null,
    contact: { name: 'Maria', phone: '+55 11 99876-5432' },
    ...overrides,
  };
}

export const GROUP_PROFILE = {
  ...TEST_PROFILE,
  projectLists: [
    { id: 'list-holding', label: 'Holding' },
    { id: 'list-contencioso', label: 'Contencioso Judicial' },
  ],
};

export function projectA(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-a',
    organizationId: 'org-a',
    name: 'Holding Silva',
    clickupTaskId: null as string | null,
    deletedAt: null,
    ...overrides,
  };
}

export function projectTask(id: string, listId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: extra.name ?? `Dossiê ${id}`,
    url: `https://app.clickup.test/t/${id}`,
    list: { id: listId, name: listId },
    status: { status: 'novo', type: 'open' },
    custom_fields: extra.custom_fields ?? [],
    tags: [],
    ...extra,
  };
}

export function groupEnv(profile: Record<string, unknown> = GROUP_PROFILE) {
  return testEnv('org-a', profile);
}

export function emptyGroupStore(tasks: any[] = []): CuStore {
  const store = emptyStore(tasks);
  store.listsInTeam = ['list-leads', 'list-acts', 'list-holding', 'list-contencioso'];
  store.listTasks['list-holding'] = tasks.filter((t) => t.list?.id === 'list-holding').map((t) => t.id);
  store.listTasks['list-contencioso'] = tasks
    .filter((t) => t.list?.id === 'list-contencioso')
    .map((t) => t.id);
  return store;
}

export const WORKBENCH_PROFILE = {
  lists: [{ id: 'list-vendas', label: 'Processo de Vendas', primary: true }],
  projectLists: [
    { id: 'list-holding', label: 'Holding' },
    { id: 'list-consultivo', label: 'Consultivo' },
    { id: 'list-iniciais', label: 'Iniciais Judiciais a Distribuir' },
  ],
  whatsappFieldId: 'field-wa',
  blockedFieldIds: ['field-blocked'],
  tag: null as string | null,
  activities: { listId: 'list-acts', relationFieldId: 'field-rel' },
};

export function workbenchEnv(profile: Record<string, unknown> = WORKBENCH_PROFILE) {
  return testEnv('org-a', profile);
}

export function emptyWorkbenchStore(tasks: any[] = []): CuStore {
  const store = emptyStore(tasks);
  store.listsInTeam = [
    'list-vendas',
    'list-acts',
    'list-holding',
    'list-consultivo',
    'list-iniciais',
  ];
  store.listTasks['list-vendas'] = tasks.filter((t) => t.list?.id === 'list-vendas').map((t) => t.id);
  store.listTasks['list-holding'] = tasks.filter((t) => t.list?.id === 'list-holding').map((t) => t.id);
  store.listTasks['list-consultivo'] = tasks
    .filter((t) => t.list?.id === 'list-consultivo')
    .map((t) => t.id);
  store.listTasks['list-iniciais'] = tasks.filter((t) => t.list?.id === 'list-iniciais').map((t) => t.id);
  return store;
}

export async function expectHttp(promise: Promise<unknown>, status: number, code: string) {
  try {
    await promise;
    throw new Error('esperava HttpException');
  } catch (err: any) {
    if (err?.message === 'esperava HttpException') throw err;
    expect(err.getStatus?.()).toBe(status);
    expect(err.getResponse?.()).toEqual(expect.objectContaining({ code }));
  }
}
