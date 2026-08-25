import { ConfigService } from '@nestjs/config';
import { ClickUpInboxConfigService } from './clickup-inbox-config.service';
import { ClickUpInboxHttpClient } from './clickup-inbox-http.client';
import { testEnv } from './clickup-inbox.test-harness';

function client(fetchFn: jest.Mock) {
  const config = new ClickUpInboxConfigService({
    get: (k: string) => testEnv()[k],
  } as ConfigService);
  return new ClickUpInboxHttpClient(config, fetchFn as any);
}

const resposta = (corpo: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => corpo,
  text: async () => {
    throw new Error('corpo bruto não deve ser lido');
  },
});

describe('ClickUp HTTP client', () => {
  it('paginação continua até página vazia', async () => {
    const paginas: number[] = [];
    const fetchFn = jest.fn(async (url: string) => {
      const pagina = Number(new URL(url).searchParams.get('page'));
      paginas.push(pagina);
      return resposta(pagina === 0 ? { tasks: [{ id: 'task-1', custom_fields: [] }] } : { tasks: [] });
    });
    const tarefas = await client(fetchFn).tarefasDaLista('list-leads');
    expect(tarefas.map((t) => t.id)).toEqual(['task-1']);
    expect(paginas).toEqual([0, 1]);
  });

  it('repetição de página falha explicitamente e não publica truncado', async () => {
    let chamadas = 0;
    const fetchFn = jest.fn(async () => {
      chamadas += 1;
      if (chamadas > 3) throw new Error('mock excedeu o limite de chamadas');
      return resposta({ tasks: [{ id: 'task-repetida', custom_fields: [] }] });
    });
    await expect(client(fetchFn).tarefasDaLista('list-leads')).rejects.toThrow(/paginação repetiu/);
    expect(chamadas).toBe(2);
  });

  it('erro HTTP é redigido e não lê corpo bruto', async () => {
    const fetchFn = jest.fn(async () => resposta({ secret: 'leak' }, 403));
    await expect(client(fetchFn).get('/user')).rejects.toThrow(/HTTP 403/);
  });
});
