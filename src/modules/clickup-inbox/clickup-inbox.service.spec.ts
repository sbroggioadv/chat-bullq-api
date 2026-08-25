import { HttpException } from '@nestjs/common';
import { serializeFieldValue, WRITABLE_FIELD_TYPES } from './domain/campos';
import { INDEX_TTL_MS } from './clickup-match.service';
import { STATUS } from './domain/casamento';
import {
  MemoryRedis,
  RedisAtividadeKv,
  limparRecuperacoesAtividade,
} from './domain/criacao-atividade';
import { MemoryW2Store, w2ReceiptKey } from './clickup-inbox-w2.store';
import {
  buildHarness,
  convA,
  emptyStore,
  expectHttp,
  leadTask,
  leadTaskWritable,
  mutationCalls,
  TEST_PROFILE,
  testEnv,
} from './clickup-inbox.test-harness';

const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';

function leadCreates(fetchFn: { mock: { calls: any[] } }) {
  return fetchFn.mock.calls.filter(
    (c: any) => String(c[0]).includes('/list/list-leads/task') && (c[1]?.method ?? 'GET') === 'POST',
  );
}

const DROP_OPS = [
  { id: 'opt-novo', rotulo: 'Novo', cor: null },
  { id: 'opt-qualif', rotulo: 'Qualificado', cor: null },
];
const LABEL_OPS = [
  { id: 'lab-a', rotulo: 'A', cor: null },
  { id: 'lab-b', rotulo: 'B', cor: null },
];

describe('ClickUpInboxService W1', () => {
  beforeEach(() => limparRecuperacoesAtividade());

  describe('AC-03 match', () => {
    it('1 card → unico com card completo', async () => {
      const task = leadTask('task-1', '+55 11 99876-5432');
      const { service } = buildHarness({
        conv: convA(),
        store: emptyStore([task]),
      });
      const out = await service.resolve('org-a', 'conv-a');
      expect(out.status).toBe(STATUS.UNICO);
      expect((out as any).card.taskId).toBe('task-1');
      expect((out as any).card.campos.some((c: any) => c.id === 'field-wa')).toBe(true);
    });

    it('N cards → ambiguo com todos os ids e nenhuma escolha automática', async () => {
      const store = emptyStore([
        leadTask('a1', '+55 11 99876-5432'),
        leadTask('b2', '11 9876-5432'),
      ]);
      const { service } = buildHarness({ conv: convA(), store });
      const out = await service.resolve('org-a', 'conv-a');
      expect(out.status).toBe(STATUS.AMBIGUO);
      expect((out as any).candidatos.map((c: any) => c.taskId)).toEqual(['a1', 'b2']);
    });

    it('0 cards → sem_card', async () => {
      const { service } = buildHarness({ conv: convA(), store: emptyStore([]) });
      const out = await service.resolve('org-a', 'conv-a');
      expect(out.status).toBe(STATUS.SEM_CARD);
    });
  });

  describe('AC-10 tenant isolation', () => {
    it('org não autorizada B → 403 e zero chamadas ClickUp', async () => {
      const { service, fetchFn } = buildHarness({ conv: convA() });
      await expectHttp(service.resolve('org-b', 'conv-a'), 403, 'CLICKUP_ORG_FORBIDDEN');
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('conversationId cruzado na org autorizada → 404 e zero chamadas', async () => {
      const { service, fetchFn } = buildHarness({
        conv: { ...convA(), organizationId: 'org-a', id: 'conv-a' },
      });
      await expectHttp(service.resolve('org-a', 'conv-de-b'), 404, 'CLICKUP_CONVERSATION_NOT_FOUND');
      expect(fetchFn.mock.calls.length).toBe(0);
    });
  });

  describe('AC-13 config', () => {
    it('config ausente → 503 e zero chamadas', async () => {
      const { service, fetchFn } = buildHarness({
        env: {},
        conv: convA(),
      });
      await expectHttp(service.resolve('org-a', 'conv-a'), 503, 'CLICKUP_NOT_CONFIGURED');
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('perfil parcial sem whatsappFieldId → 503 e zero chamadas', async () => {
      const { service, fetchFn } = buildHarness({
        env: testEnv('org-a', {
          lists: [{ id: 'list-leads', label: 'Leads', primary: true }],
          whatsappFieldId: '',
          blockedFieldIds: [],
          tag: null,
          activities: null,
        }),
        conv: convA(),
      });
      await expectHttp(service.resolve('org-a', 'conv-a'), 503, 'CLICKUP_NOT_CONFIGURED');
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('403 de credencial degrada em 503 permanente; 5xx permite retry', async () => {
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      store.statusCode = 403;
      const forbidden = buildHarness({ conv: convA(), store });
      await expectHttp(forbidden.service.resolve('org-a', 'conv-a'), 503, 'CLICKUP_NOT_CONFIGURED');
      const calls = forbidden.fetchFn.mock.calls.length;
      await expectHttp(forbidden.service.resolve('org-a', 'conv-a'), 503, 'CLICKUP_NOT_CONFIGURED');
      expect(forbidden.fetchFn.mock.calls.length).toBe(calls);

      const five = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      five.statusCode = 500;
      const boom = buildHarness({ conv: convA(), store: five });
      await expectHttp(boom.service.resolve('org-a', 'conv-a'), 502, 'CLICKUP_UPSTREAM');
      const n = boom.fetchFn.mock.calls.length;
      await expectHttp(boom.service.resolve('org-a', 'conv-a'), 502, 'CLICKUP_UPSTREAM');
      expect(boom.fetchFn.mock.calls.length).toBeGreaterThan(n);
    });

    it('whatsapp ausente na lista secundária → 503 e zero task', async () => {
      const profile = {
        ...TEST_PROFILE,
        lists: [
          { id: 'list-leads', label: 'Leads', primary: true },
          { id: 'list-two', label: 'Outros', primary: false },
        ],
      };
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      store.listsInTeam = ['list-leads', 'list-two', 'list-acts'];
      store.fieldsByList = {
        'list-two': [{ id: 'field-other', name: 'X', type: 'text' }],
      };
      const { service, fetchFn } = buildHarness({
        env: testEnv('org-a', profile),
        conv: convA(),
        store,
      });
      await expectHttp(service.resolve('org-a', 'conv-a'), 503, 'CLICKUP_NOT_CONFIGURED');
      const urls = fetchFn.mock.calls.map((c: any) => String(c[0]));
      expect(urls.some((u: string) => u.includes('/task/'))).toBe(false);
      expect(urls.some((u: string) => /\/list\/list-leads\/task/.test(u))).toBe(false);
    });

    it('lista fora do team → 503 e zero chamada útil de task', async () => {
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      store.listsInTeam = ['list-outra'];
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await expectHttp(service.resolve('org-a', 'conv-a'), 503, 'CLICKUP_NOT_CONFIGURED');
      const urls = fetchFn.mock.calls.map((c: any) => String(c[0]));
      expect(urls.some((u: string) => u.includes('/task/'))).toBe(false);
      expect(urls.some((u: string) => /\/list\/list-leads\/task/.test(u))).toBe(false);
    });
  });

  describe('AC-11 cache', () => {
    it('chave inclui org+fingerprint, sem PII, coalescido, sem parcial', async () => {
      const task = leadTask('task-1', '+55 11 99876-5432', {
        name: 'Nome que não pode persistir',
      });
      const store = emptyStore([task]);
      const { match, fetchFn, config } = buildHarness({ conv: convA(), store });
      const [a, b] = await Promise.all([
        match.garantirIndice('org-a'),
        match.garantirIndice('org-a'),
      ]);
      expect(a).toBe(b);
      const key = match.cacheKey('org-a');
      expect(key.startsWith('org-a:')).toBe(true);
      expect(key).toContain(config.fingerprint());
      const cache = match.peek('org-a')!;
      const serial = JSON.stringify({
        pares: [...cache.indice.entries()],
        total: cache.total,
        ignorados: cache.ignorados,
      });
      expect(serial.includes('Nome que')).toBe(false);
      expect(serial.includes('app.clickup.test')).toBe(false);
      expect(cache.indice.get('551198765432')).toEqual(['task-1']);

      const indexCalls = fetchFn.mock.calls.filter((c: any) =>
        String(c[0]).includes('/list/list-leads/task'),
      );
      expect(indexCalls.length).toBeGreaterThan(0);
      expect(cache.expiraEm - cache.atualizadoEm).toBe(INDEX_TTL_MS);
    });

    it('paginação repetida não publica cache parcial', async () => {
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      store.failPages = true;
      const { match } = buildHarness({ conv: convA(), store });
      await expect(match.garantirIndice('org-a')).rejects.toThrow(/paginação repetiu/);
      expect(match.peek('org-a')).toBeUndefined();
    });
  });

  describe('AC-05 + AC-09 campos', () => {
    it('grava cada tipo da matriz com payload exato', async () => {
      const task = leadTaskWritable('task-1', '+55 11 99876-5432');
      const store = emptyStore([task]);
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();

      const cases: Array<[string, string, unknown, ReturnType<typeof serializeFieldValue>]> = [
        ['field-drop', 'drop_down', 'opt-qualif', serializeFieldValue('drop_down', 'opt-qualif', DROP_OPS)],
        ['field-labels', 'labels', ['lab-a'], serializeFieldValue('labels', ['lab-a'], LABEL_OPS)],
        ['field-date', 'date', '2026-08-25', serializeFieldValue('date', '2026-08-25')],
        ['field-currency', 'currency', '10.50', serializeFieldValue('currency', '10.50')],
        ['field-email', 'email', 'a@b.test', serializeFieldValue('email', 'a@b.test')],
        ['field-phone', 'phone', '1199', serializeFieldValue('phone', '1199')],
        ['field-url', 'url', 'https://example.test', serializeFieldValue('url', 'https://example.test')],
        ['field-short', 'short_text', 'oi', serializeFieldValue('short_text', 'oi')],
        ['field-text', 'text', 'bloco', serializeFieldValue('text', 'bloco')],
      ];
      for (const [fieldId, , value, serialized] of cases) {
        fetchFn.mockClear();
        await service.patchField('org-a', 'conv-a', 'task-1', fieldId, value);
        const write = fetchFn.mock.calls.find(
          (c: any) => String(c[0]).includes(`/field/${fieldId}`) && c[1]?.method === 'POST',
        );
        expect(write).toBeTruthy();
        const payload = JSON.parse(String(write[1].body));
        expect(payload).toEqual({ value: serialized.ok ? serialized.value : null });
      }
      expect(WRITABLE_FIELD_TYPES).toHaveLength(9);
    });

    it('campo só na lista, write-noop, option forjada e telefone desvinculado', async () => {
      const onlyWa = leadTask('task-1', '+55 11 99876-5432');
      const store = emptyStore([onlyWa]);
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();
      await expectHttp(
        service.patchField('org-a', 'conv-a', 'task-1', 'field-short', 'oi'),
        404,
        'CLICKUP_TASK_NOT_BOUND',
      );
      expect(mutationCalls(fetchFn).length).toBe(0);

      const full = emptyStore([leadTaskWritable('task-1', '+55 11 99876-5432')]);
      full.ignoreFieldWrites = true;
      const noop = buildHarness({ conv: convA(), store: full });
      await noop.service.resolve('org-a', 'conv-a');
      await expectHttp(
        noop.service.patchField('org-a', 'conv-a', 'task-1', 'field-short', 'oi'),
        502,
        'CLICKUP_UPSTREAM',
      );

      const forged = buildHarness({
        conv: convA(),
        store: emptyStore([leadTaskWritable('task-1', '+55 11 99876-5432')]),
      });
      await forged.service.resolve('org-a', 'conv-a');
      forged.fetchFn.mockClear();
      await expectHttp(
        forged.service.patchField('org-a', 'conv-a', 'task-1', 'field-drop', 'opt-forjado'),
        422,
        'CLICKUP_INVALID_VALUE',
      );
      expect(mutationCalls(forged.fetchFn).length).toBe(0);

      const unbind = buildHarness({
        conv: convA(),
        store: emptyStore([leadTaskWritable('task-1', '+55 11 99876-5432')]),
      });
      await unbind.service.resolve('org-a', 'conv-a');
      const out = await unbind.service.patchField(
        'org-a',
        'conv-a',
        'task-1',
        'field-wa',
        '21988881111',
      );
      expect(out.unbound).toBe(true);
      expect(out.match?.status).toBe(STATUS.SEM_CARD);
    });

    it('tipo somente leitura, bloqueado e fieldId ausente: zero escrita', async () => {
      const task = leadTaskWritable('task-1', '+55 11 99876-5432');
      const store = emptyStore([task]);
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');

      for (const [fieldId, value] of [
        ['field-users', 'x'],
        ['field-mystery', 'x'],
        ['field-blocked', 'segredo'],
        ['field-ausente', 'x'],
      ] as const) {
        fetchFn.mockClear();
        await expect(service.patchField('org-a', 'conv-a', 'task-1', fieldId, value)).rejects.toBeInstanceOf(
          HttpException,
        );
        const writes = fetchFn.mock.calls.filter((c: any) => (c[1]?.method ?? 'GET') !== 'GET');
        expect(writes.length).toBe(0);
      }
    });
  });

  describe('AC-06 status', () => {
    it('status fora de etapas falha antes da rede; válido confirma por releitura', async () => {
      const task = leadTask('task-1', '+55 11 99876-5432');
      const store = emptyStore([task]);
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();
      await expect(service.patchStatus('org-a', 'conv-a', 'task-1', 'inexistente')).rejects.toMatchObject({
      });
      expect(
        fetchFn.mock.calls.filter((c: any) => (c[1]?.method ?? 'GET') === 'PUT').length,
      ).toBe(0);

      fetchFn.mockClear();
      const out = await service.patchStatus('org-a', 'conv-a', 'task-1', 'andamento');
      expect(out.ok).toBe(true);
      expect(out.etapa).toBe('andamento');
      expect(store.tasks['task-1'].status.status).toBe('andamento');
    });
  });

  describe('AC-07 atividades', () => {
    it('atividades off fazem zero escrita', async () => {
      const profile = { ...TEST_PROFILE, activities: null };
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      const { service, fetchFn } = buildHarness({
        env: testEnv('org-a', profile),
        conv: convA(),
        store,
      });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();
      await expectHttp(
        service.postActivity('org-a', 'conv-a', 'task-1', { name: 'Retorno' }),
        412,
        'CLICKUP_ACTIVITIES_UNAVAILABLE',
      );
      const writes = fetchFn.mock.calls.filter((c: any) => (c[1]?.method ?? 'GET') !== 'GET');
      expect(writes.length).toBe(0);
    });

    it('on: cria, retry sem duplicar e conclui por status closed', async () => {
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      const { service } = buildHarness({ conv: convA(), store });
      const created = await service.postActivity('org-a', 'conv-a', 'task-1', { name: 'Retorno' });
      expect(created.ok).toBe(true);
      const id = created.atividadeId;
      const retry = await service.postActivity('org-a', 'conv-a', 'task-1', { name: 'Retorno' });
      expect(retry.atividadeId).toBe(id);
      const done = await service.completeActivity('org-a', 'conv-a', 'task-1', id);
      expect(done.status).toBe('encerrada');
      expect(store.tasks[id].status.type).toBe('closed');
    });
  });

  describe('AC-08 comentário', () => {
    it('envia notify_all false, usa o usuário e confirma por releitura', async () => {
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      const out = await service.postComment('org-a', 'conv-a', 'task-1', 'user-1', {
        oQue: 'Falei com a cliente',
        proximoPasso: 'Enviar proposta',
      });
      expect(out.ok).toBe(true);
      const write = fetchFn.mock.calls.find((c: any) =>
        String(c[0]).includes('/comment') && c[1]?.method === 'POST',
      );
      const payload = JSON.parse(String(write[1].body));
      expect(payload.notify_all).toBe(false);
      expect(payload.comment_text).toContain('Ana');
      expect(payload.comment_text).toContain('Falei com a cliente');
      expect(payload.comment_text).toContain('Enviar proposta');
      expect(out.comentarios.some((c: any) => c.id === out.comentarioId)).toBe(true);
    });

    it('recusa termo sensível só no próximo passo sem POST', async () => {
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();
      await expectHttp(
        service.postComment('org-a', 'conv-a', 'task-1', 'user-1', {
          oQue: 'Falei com a cliente',
          proximoPasso: 'revelar a margem combinada',
        }),
        422,
        'CLICKUP_INVALID_VALUE',
      );
      expect(mutationCalls(fetchFn).length).toBe(0);
    });
  });

  describe('AC-09 binding', () => {
    it('lista errada com telefone igual falha sem mutação', async () => {
      const other = leadTask('task-x', '+55 11 99876-5432');
      other.list = { id: 'list-outra', name: 'Outra' };
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      store.tasks['task-x'] = other;
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();
      await expectHttp(
        service.patchStatus('org-a', 'conv-a', 'task-x', 'andamento'),
        404,
        'CLICKUP_TASK_NOT_BOUND',
      );
      expect(mutationCalls(fetchFn).length).toBe(0);
    });

    it('lista permitida com telefone diferente falha sem mutação', async () => {
      const other = leadTask('task-y', '+55 21 98888-1111');
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432'), other]);
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();
      await expectHttp(
        service.patchStatus('org-a', 'conv-a', 'task-y', 'andamento'),
        404,
        'CLICKUP_TASK_NOT_BOUND',
      );
      expect(mutationCalls(fetchFn).length).toBe(0);
    });

    it('atividade em lista errada, relação errada e destino incompatível', async () => {
      const lead = leadTaskWritable('task-1', '+55 11 99876-5432');
      const store = emptyStore([lead]);
      const wrongList = {
        id: 'act-wrong-list',
        name: 'X',
        list: { id: 'list-leads', name: 'Leads' },
        status: { status: 'novo', type: 'open' },
        custom_fields: [{ id: 'field-rel', value: ['task-1'] }],
      };
      const wrongRel = {
        id: 'act-wrong-rel',
        name: 'Y',
        list: { id: 'list-acts', name: 'Atividades' },
        status: { status: 'novo', type: 'open' },
        custom_fields: [{ id: 'field-rel', value: ['outra'] }],
      };
      store.tasks['act-wrong-list'] = wrongList;
      store.tasks['act-wrong-rel'] = wrongRel;
      store.listTasks['list-acts'].push('act-wrong-rel');
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();
      await expectHttp(
        service.completeActivity('org-a', 'conv-a', 'task-1', 'act-wrong-list'),
        404,
        'CLICKUP_TASK_NOT_BOUND',
      );
      expect(mutationCalls(fetchFn).length).toBe(0);
      fetchFn.mockClear();
      await expectHttp(
        service.completeActivity('org-a', 'conv-a', 'task-1', 'act-wrong-rel'),
        404,
        'CLICKUP_TASK_NOT_BOUND',
      );
      expect(mutationCalls(fetchFn).length).toBe(0);

      store.relationListId = 'list-outra';
      fetchFn.mockClear();
      await expectHttp(
        service.postActivity('org-a', 'conv-a', 'task-1', { name: 'Não criar' }),
        412,
        'CLICKUP_ACTIVITIES_UNAVAILABLE',
      );
      expect(
        fetchFn.mock.calls.filter((c: any) => (c[1]?.method ?? 'GET') === 'POST').length,
      ).toBe(0);
    });
  });

  describe('F-03 tenant-first e remoto transitório', () => {
    it('org B com fieldId inválido é 403 sem Prisma/fetch', async () => {
      const { service, fetchFn, prisma } = buildHarness({ conv: convA() });
      await expectHttp(
        service.patchField('org-b', 'conv-a', 'task-1', '!', 'x'),
        403,
        'CLICKUP_ORG_FORBIDDEN',
      );
      expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('timeout de validação remota é 504 e a próxima request tenta de novo', async () => {
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      store.statusCode = 504;
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await expectHttp(service.resolve('org-a', 'conv-a'), 504, 'CLICKUP_TIMEOUT');
      const first = fetchFn.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      await expectHttp(service.resolve('org-a', 'conv-a'), 504, 'CLICKUP_TIMEOUT');
      expect(fetchFn.mock.calls.length).toBeGreaterThan(first);
    });
  });

  describe('F-04 receipt durável', () => {
    it('retry em nova instância reusa o id sem novo POST', async () => {
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      const redis = new MemoryRedis();
      const kv = new RedisAtividadeKv(redis);
      const first = buildHarness({ conv: convA(), store, atividadeKv: kv });
      const created = await first.service.postActivity('org-a', 'conv-a', 'task-1', {
        name: 'Retorno',
      });
      const posts = first.fetchFn.mock.calls.filter(
        (c: any) => String(c[0]).includes('/list/list-acts/task') && c[1]?.method === 'POST',
      ).length;
      expect(posts).toBe(1);
      const second = buildHarness({
        conv: convA(),
        store,
        fetchFn: first.fetchFn,
        atividadeKv: new RedisAtividadeKv(redis),
      });
      second.fetchFn.mockClear();
      const retry = await second.service.postActivity('org-a', 'conv-a', 'task-1', {
        name: 'Retorno',
      });
      expect(retry.atividadeId).toBe(created.atividadeId);
      expect(
        second.fetchFn.mock.calls.filter(
          (c: any) => String(c[0]).includes('/list/list-acts/task') && c[1]?.method === 'POST',
        ).length,
      ).toBe(0);
    });

    it('falha real de retenção Redis executa compensação', async () => {
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432')]);
      const kv = new RedisAtividadeKv(new MemoryRedis(new Map(), true));
      const { service } = buildHarness({ conv: convA(), store, atividadeKv: kv });
      await expectHttp(
        service.postActivity('org-a', 'conv-a', 'task-1', { name: 'Compensar' }),
        502,
        'CLICKUP_UPSTREAM',
      );
      expect(Object.keys(store.tasks).some((id) => id.startsWith('act-'))).toBe(false);
    });
  });

  describe('estados locais sem ClickUp', () => {
    it('grupo não chama ClickUp', async () => {
      const { service, fetchFn } = buildHarness({
        conv: convA({ isGroup: true }),
        store: emptyStore([leadTask('task-1', '+55 11 99876-5432')]),
      });
      const out = await service.resolve('org-a', 'conv-a');
      expect(out.status).toBe(STATUS.GRUPO);
      expect(fetchFn.mock.calls.length).toBe(0);
    });

    it('telefone fora do padrão não chama ClickUp', async () => {
      const { service, fetchFn } = buildHarness({
        conv: convA({ contact: { name: 'X', phone: '+1 415 555 0000' } }),
      });
      const out = await service.resolve('org-a', 'conv-a');
      expect(out.status).toBe(STATUS.FORA_DO_PADRAO);
      expect(fetchFn.mock.calls.length).toBe(0);
    });
  });

  describe('W2 criar card AC-14..17', () => {
    it('sem_card + nome cria na lista principal com nome e telefone', async () => {
      const { service, fetchFn, store } = buildHarness({
        conv: convA(),
        store: emptyStore([]),
      });
      const out = await service.createTask('org-a', 'conv-a', KEY_A);
      expect(out.ok).toBe(true);
      expect(out.status).toBe(STATUS.UNICO);
      expect(out.card.nome).toBe('Maria');
      const write = leadCreates(fetchFn)[0];
      expect(write).toBeTruthy();
      const payload = JSON.parse(String(write[1].body));
      expect(payload.name).toBe('Maria');
      expect(payload.custom_fields).toEqual([{ id: 'field-wa', value: '551198765432' }]);
      expect(String(write[0])).toContain('/list/list-leads/task');
      expect(store.tasks[out.card.taskId].list.id).toBe('list-leads');
    });

    it('grupo, recusado, N, 1 e nome vazio fazem zero POST', async () => {
      const cases = [
        convA({ isGroup: true }),
        convA({ contact: { name: 'Maria', phone: '+1 415 555 0000' } }),
        convA({ contact: { name: '', phone: '+55 11 99876-5432' } }),
      ];
      for (const conv of cases) {
        const { service, fetchFn } = buildHarness({ conv, store: emptyStore([]) });
        await expect(service.createTask('org-a', 'conv-a', KEY_A)).rejects.toBeInstanceOf(
          HttpException,
        );
        expect(leadCreates(fetchFn).length).toBe(0);
      }

      const unico = buildHarness({
        conv: convA(),
        store: emptyStore([leadTask('task-1', '+55 11 99876-5432')]),
      });
      await expectHttp(
        unico.service.createTask('org-a', 'conv-a', KEY_A),
        409,
        'CLICKUP_MATCH_CONFLICT',
      );
      expect(leadCreates(unico.fetchFn).length).toBe(0);

      const n = buildHarness({
        conv: convA(),
        store: emptyStore([
          leadTask('a1', '+55 11 99876-5432'),
          leadTask('b2', '11 9876-5432'),
        ]),
      });
      await expectHttp(n.service.createTask('org-a', 'conv-a', KEY_A), 409, 'CLICKUP_MATCH_CONFLICT');
      expect(leadCreates(n.fetchFn).length).toBe(0);
    });

    it('concorrência com keys diferentes cria uma task; retry da mesma key devolve o mesmo id', async () => {
      const w2 = new MemoryW2Store();
      const { service, fetchFn } = buildHarness({
        conv: convA(),
        store: emptyStore([]),
        w2Store: w2,
      });
      const settled = await Promise.allSettled([
        service.createTask('org-a', 'conv-a', KEY_A),
        service.createTask('org-a', 'conv-a', KEY_B),
      ]);
      const ok = settled.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const bad = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok.length).toBe(1);
      expect(bad.length).toBe(1);
      expect(bad[0].reason.getStatus()).toBe(409);
      expect(leadCreates(fetchFn).length).toBe(1);
      const taskId = ok[0].value.card.taskId;
      fetchFn.mockClear();
      const usedKey = w2.receipts.has(w2ReceiptKey('org-a', '551198765432', KEY_A)) ? KEY_A : KEY_B;
      const retry = await service.createTask('org-a', 'conv-a', usedKey);
      expect(retry.card.taskId).toBe(taskId);
      expect(leadCreates(fetchFn).length).toBe(0);
    });

    it('card surgindo antes do POST gera 409 e zero criação', async () => {
      const store = emptyStore([]);
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      store.tasks['task-late'] = leadTask('task-late', '+55 11 99876-5432');
      store.listTasks['list-leads'] = ['task-late'];
      await expectHttp(
        service.createTask('org-a', 'conv-a', KEY_A),
        409,
        'CLICKUP_MATCH_CONFLICT',
      );
      expect(leadCreates(fetchFn).length).toBe(0);
    });

    it('Redis indisponível falha antes de qualquer chamada ClickUp', async () => {
      const w2 = new MemoryW2Store();
      w2.failReady = true;
      const { service, fetchFn } = buildHarness({
        conv: convA(),
        store: emptyStore([]),
        w2Store: w2,
      });
      await expectHttp(
        service.createTask('org-a', 'conv-a', KEY_A),
        503,
        'CLICKUP_STORE_UNAVAILABLE',
      );
      expect(fetchFn.mock.calls.length).toBe(0);
    });
  });
});

describe('AC-12 varredura do módulo', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');

  function walk(dir: string): string[] {
    return fs.readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) return walk(full);
      if (!/\.(ts|js|json)$/.test(name)) return [];
      if (name.includes('.spec.') || name.includes('test-harness')) return [];
      return [full];
    });
  }

  it('código novo não traz Hoppe/Bravy/sinkra nem aliases proibidos', () => {
    const root = __dirname;
    const files = walk(root);
    const joined = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(joined).not.toMatch(/hoppe/i);
    expect(joined).not.toMatch(/bravy/i);
    expect(joined).not.toMatch(/sinkra/i);
    expect(joined).not.toMatch(/CLICKUP_API_TOKEN/);
    expect(joined).not.toMatch(/CLICKUP_LIST_ID/);
    expect(joined).not.toMatch(/pk_[A-Za-z0-9]{20,}/);
  });
});
