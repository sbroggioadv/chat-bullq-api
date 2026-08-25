import { Inject, Injectable, Optional } from '@nestjs/common';
import { idSeguro } from './domain/ids';
import type { CampoMeta } from './domain/campos';
import { listaPrincipal, type ClickUpInboxActivities } from './domain/perfil';
import { ClickUpInboxConfigService } from './clickup-inbox-config.service';
import { CLICKUP_FETCH } from './clickup-inbox.tokens';
import { notConfigured } from './clickup-inbox.errors';

export const CLICKUP_TIMEOUT_MS = 15_000;
const BASE = 'https://api.clickup.com/api/v2';

export type ClickUpFetch = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

@Injectable()
export class ClickUpInboxHttpClient {
  private readonly timeoutMs = CLICKUP_TIMEOUT_MS;
  private readonly fetchFn: ClickUpFetch;

  constructor(
    private readonly config: ClickUpInboxConfigService,
    @Optional() @Inject(CLICKUP_FETCH) fetchFn?: ClickUpFetch,
  ) {
    this.fetchFn = fetchFn ?? (globalThis.fetch.bind(globalThis) as ClickUpFetch);
  }

  async request(path: string, opts: { method?: string; body?: unknown } = {}): Promise<any> {
    const local = this.config.snapshot();
    if (!local.ok) notConfigured(local.reason);
    const metodo = opts.method ?? 'GET';
    const controlador = new AbortController();
    const timer = setTimeout(() => controlador.abort(), this.timeoutMs);
    try {
      const resposta = await this.fetchFn(`${BASE}${path}`, {
        method: metodo,
        headers: {
          Authorization: local.apiKey,
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controlador.signal,
      });
      if (!resposta.ok) {
        const erro = new Error(`ClickUp recusou a requisição (HTTP ${resposta.status})`) as Error & {
          status: number;
        };
        erro.status = resposta.status;
        throw erro;
      }
      return resposta.json().catch(() => ({}));
    } catch (erro) {
      if ((erro as { name?: string })?.name === 'AbortError') {
        const timeout = new Error(`ClickUp: tempo limite de ${this.timeoutMs} ms excedido`) as Error & {
          status: number;
        };
        timeout.status = 504;
        throw timeout;
      }
      throw erro;
    } finally {
      clearTimeout(timer);
    }
  }

  get(path: string) {
    return this.request(path);
  }

  write(path: string, body?: unknown, method = 'POST') {
    return this.request(path, { method, body });
  }

  async tarefasDaLista(listId: string): Promise<any[]> {
    if (!idSeguro(listId)) throw new Error('lista inválida');
    const saida: any[] = [];
    const assinaturas = new Set<string>();
    let pagina = 0;

    while (true) {
      const resposta = await this.get(
        `/list/${encodeURIComponent(listId)}/task?include_closed=true&subtasks=false&page=${pagina}`,
      );
      const tarefas = Array.isArray(resposta.tasks) ? resposta.tasks : [];
      if (tarefas.length === 0) return saida;

      const assinatura = tarefas.map((task: { id?: string }) => task.id).join('|');
      if (assinaturas.has(assinatura)) {
        throw new Error(
          `ClickUp: paginação repetiu a página ${pagina}; indexação interrompida explicitamente`,
        );
      }
      assinaturas.add(assinatura);
      saida.push(...tarefas);
      if (resposta.last_page === true) return saida;
      pagina += 1;
      if (pagina > 10_000) {
        throw new Error(
          'ClickUp: paginação excedeu 10.000 páginas; nenhuma página foi truncada silenciosamente',
        );
      }
    }
  }

  async taskBruta(taskId: string) {
    if (!idSeguro(taskId)) throw new Error('task inválida');
    return this.get(`/task/${encodeURIComponent(taskId)}?include_subtasks=false&include_closed=true`);
  }

  async camposDaLista(listId: string): Promise<CampoMeta[]> {
    if (!idSeguro(listId)) throw new Error('lista inválida');
    const { fields = [] } = await this.get(`/list/${encodeURIComponent(listId)}/field`);
    return (fields as any[]).map((campo) => ({
      id: String(campo.id),
      nome: String(campo.name ?? ''),
      tipo: String(campo.type ?? ''),
      opcoes: (campo.type_config?.options ?? []).map((opcao: any) => ({
        id: String(opcao.id),
        rotulo: String(opcao.name ?? opcao.label ?? ''),
        cor: opcao.color ?? null,
      })),
      moeda: campo.type_config?.currency_type ?? null,
    }));
  }

  async listasDoTime(teamId: string): Promise<Array<{ id: string; nome: string }>> {
    if (!idSeguro(teamId)) throw new Error('workspace inválido');
    const { spaces = [] } = await this.get(
      `/team/${encodeURIComponent(teamId)}/space?archived=false`,
    );
    const saida: Array<{ id: string; nome: string }> = [];
    for (const space of spaces as any[]) {
      const [{ folders = [] }, { lists = [] }] = await Promise.all([
        this.get(`/space/${encodeURIComponent(space.id)}/folder?archived=false`),
        this.get(`/space/${encodeURIComponent(space.id)}/list?archived=false`),
      ]);
      for (const lista of lists as any[]) {
        saida.push({ id: String(lista.id), nome: String(lista.name ?? '') });
      }
      for (const pasta of folders as any[]) {
        for (const lista of pasta.lists ?? []) {
          saida.push({ id: String(lista.id), nome: String(lista.name ?? '') });
        }
      }
    }
    return saida;
  }

  async comentarios(taskId: string, limite = 8) {
    if (!idSeguro(taskId)) throw new Error('task inválida');
    const { comments = [] } = await this.get(`/task/${encodeURIComponent(taskId)}/comment`);
    return (comments as any[]).slice(0, limite).map((comentario) => ({
      id: String(comentario.id),
      texto: String(comentario.comment_text ?? ''),
      quem: comentario.user?.username ?? null,
      data: comentario.date ?? null,
    }));
  }

  async statusConclusaoDaLista(listId: string): Promise<string> {
    const lista = await this.get(`/list/${encodeURIComponent(listId)}`);
    const fechado = (lista.statuses ?? []).find((status: { type?: string }) => status.type === 'closed');
    if (!fechado?.status) {
      const erro = new Error('a lista de atividades não possui status do tipo closed') as Error & {
        status: number;
      };
      erro.status = 412;
      throw erro;
    }
    return String(fechado.status);
  }

  async apagarTask(taskId: string) {
    if (!idSeguro(taskId)) throw new Error('task inválida');
    await this.write(`/task/${encodeURIComponent(taskId)}`, undefined, 'DELETE');
  }

  async validarRelacaoAtividade(activities: ClickUpInboxActivities) {
    const lista = await this.get(`/list/${encodeURIComponent(activities.listId)}`);
    if (String(lista?.id) !== activities.listId) {
      const erro = new Error('lista de atividades configurada não está acessível') as Error & {
        status: number;
      };
      erro.status = 412;
      throw erro;
    }
    const respostaCampos = await this.get(
      `/list/${encodeURIComponent(activities.listId)}/field?include_applied_objects=true`,
    );
    const campos = Array.isArray(respostaCampos?.fields) ? respostaCampos.fields : [];
    const campo = campos.find((item: { id?: string }) => String(item?.id) === activities.relationFieldId);
    if (!campo || campo.type !== 'list_relationship') {
      const erro = new Error(
        'campo de relacionamento não existe ou é incompatível com atividades',
      ) as Error & { status: number };
      erro.status = 412;
      throw erro;
    }
    return { listaId: activities.listId, campoId: activities.relationFieldId, campo, lista };
  }

  async validateRemoteConfig(): Promise<void> {
    const local = this.config.assertLocal();
    await this.get('/user');
    const { teams = [] } = await this.get('/team');
    const teamOk = (teams as Array<{ id?: string }>).some(
      (team) => String(team.id) === local.teamId,
    );
    if (!teamOk) {
      throw new Error('CLICKUP_TEAM_ID inacessível');
    }

    const listas = await this.listasDoTime(local.teamId);
    const idsNoTeam = new Set(listas.map((lista) => lista.id));
    const required = [
      ...local.profile.lists.map((lista) => lista.id),
      ...(local.profile.activities ? [local.profile.activities.listId] : []),
    ];
    for (const id of required) {
      if (!idsNoTeam.has(id)) {
        throw new Error('lista do perfil não pertence ao team');
      }
    }

    const primary = listaPrincipal(local.profile);
    const campos = await this.camposDaLista(primary);
    if (!campos.some((campo) => campo.id === local.profile.whatsappFieldId)) {
      throw new Error('campo WhatsApp inacessível');
    }
    if (local.profile.activities) {
      await this.validarRelacaoAtividade(local.profile.activities);
    }
  }
}
