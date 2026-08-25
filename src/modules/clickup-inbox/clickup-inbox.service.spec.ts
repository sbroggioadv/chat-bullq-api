import { HttpException } from '@nestjs/common';
import { serializeFieldValue, WRITABLE_FIELD_TYPES } from './domain/campos';
import { INDEX_TTL_MS } from './clickup-match.service';
import { STATUS } from './domain/casamento';
import { limparRecuperacoesAtividade } from './domain/criacao-atividade';
import {
  buildHarness,
  convA,
  emptyStore,
  expectHttp,
  leadTask,
  TEST_PROFILE,
  testEnv,
} from './clickup-inbox.test-harness';

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
      const task = leadTask('task-1', '+55 11 99876-5432');
      const store = emptyStore([task]);
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();

      const cases: Array<[string, string, unknown]> = [
        ['field-drop', 'drop_down', 'opt-qualif'],
        ['field-labels', 'labels', ['lab-a']],
        ['field-date', 'date', '2026-08-25'],
        ['field-currency', 'currency', '10.50'],
        ['field-email', 'email', 'a@b.test'],
        ['field-phone', 'phone', '1199'],
        ['field-url', 'url', 'https://example.test'],
        ['field-short', 'short_text', 'oi'],
        ['field-text', 'text', 'bloco'],
      ];
      for (const [fieldId, tipo, value] of cases) {
        fetchFn.mockClear();
        await service.patchField('org-a', 'conv-a', 'task-1', fieldId, value);
        const write = fetchFn.mock.calls.find(
          (c: any) => String(c[0]).includes(`/field/${fieldId}`) && c[1]?.method === 'POST',
        );
        expect(write).toBeTruthy();
        const payload = JSON.parse(String(write[1].body));
        expect(payload).toEqual({ value: serializeFieldValue(tipo, value).ok
          ? (serializeFieldValue(tipo, value) as { value: unknown }).value
          : null });
      }
      expect(WRITABLE_FIELD_TYPES).toHaveLength(9);
    });

    it('tipo somente leitura, bloqueado e fieldId ausente: zero escrita', async () => {
      const task = leadTask('task-1', '+55 11 99876-5432');
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
  });

  describe('AC-09 binding', () => {
    it('task em lista errada ou telefone diferente falha sem mutação', async () => {
      const other = leadTask('task-x', '+55 21 98888-1111');
      other.list = { id: 'list-outra', name: 'Outra' };
      const store = emptyStore([leadTask('task-1', '+55 11 99876-5432'), other]);
      store.tasks['task-x'] = other;
      const { service, fetchFn } = buildHarness({ conv: convA(), store });
      await service.resolve('org-a', 'conv-a');
      fetchFn.mockClear();
      await expectHttp(
        service.patchStatus('org-a', 'conv-a', 'task-x', 'andamento'),
        404,
        'CLICKUP_TASK_NOT_BOUND',
      );
      const writes = fetchFn.mock.calls.filter((c: any) => (c[1]?.method ?? 'GET') !== 'GET');
      expect(writes.length).toBe(0);
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
