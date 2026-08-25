import { createHash } from 'crypto';
import { idSeguro } from './ids';

const PREFIXO = 'atividade-recuperacao:';
export const RECUPERACAO_TTL_MS = 10 * 60 * 1000;

export type AtividadeEscopo = {
  organizationId: string;
  taskId: string;
  listaId: string;
  campoId: string;
  nome: string;
  dueDate: number | null;
};

export type AtividadeRegistro = {
  atividadeId: string;
  taskId: string;
  listaId: string;
  campoId: string;
  expiraEm: number;
};

export type AtividadeKv = {
  get(chave: string): Promise<Record<string, AtividadeRegistro | undefined>>;
  set(objeto: Record<string, AtividadeRegistro>): Promise<void>;
  remove(chave: string): Promise<void>;
};

const emAndamento = new Map<string, Promise<unknown>>();
const recuperacoesEmMemoria = new Map<string, AtividadeRegistro>();

export function limparRecuperacoesAtividade() {
  emAndamento.clear();
  recuperacoesEmMemoria.clear();
}

export function digestEscopo(valor: AtividadeEscopo): string {
  return createHash('sha256').update(JSON.stringify(valor)).digest('hex');
}

function registroValido(
  registro: AtividadeRegistro | undefined,
  escopo: AtividadeEscopo,
  agora: number,
): boolean {
  return Boolean(
    registro
      && idSeguro(registro.atividadeId)
      && registro.taskId === escopo.taskId
      && registro.listaId === escopo.listaId
      && registro.campoId === escopo.campoId
      && Number.isFinite(registro.expiraEm)
      && registro.expiraEm > agora,
  );
}

function criarRegistro(atividadeId: string, escopo: AtividadeEscopo, agora: number): AtividadeRegistro {
  return {
    atividadeId,
    taskId: escopo.taskId,
    listaId: escopo.listaId,
    campoId: escopo.campoId,
    expiraEm: agora + RECUPERACAO_TTL_MS,
  };
}

function expirarRecuperacoes(agora: number) {
  for (const [chave, registro] of recuperacoesEmMemoria) {
    if (!Number.isFinite(registro?.expiraEm) || registro.expiraEm <= agora) {
      recuperacoesEmMemoria.delete(chave);
    }
  }
}

async function executar<T>(opcoes: {
  storage: AtividadeKv;
  escopo: AtividadeEscopo;
  validar: () => Promise<void>;
  criar: () => Promise<{ id?: string } | null | undefined>;
  confirmar: (atividadeId: string) => Promise<T>;
  compensar: (atividadeId: string) => Promise<void>;
  agora: number;
  chaveOperacao: string;
}): Promise<T> {
  await opcoes.validar();
  expirarRecuperacoes(opcoes.agora);
  const chave = `${PREFIXO}${opcoes.chaveOperacao}`;
  const salvoBag = await opcoes.storage.get(chave);
  const salvo = salvoBag[chave];
  const memoria = recuperacoesEmMemoria.get(opcoes.chaveOperacao);
  let atividadeId = registroValido(salvo, opcoes.escopo, opcoes.agora)
    ? salvo!.atividadeId
    : registroValido(memoria, opcoes.escopo, opcoes.agora)
      ? memoria!.atividadeId
      : null;
  if (!atividadeId && salvo !== undefined) await opcoes.storage.remove(chave);

  if (!atividadeId) {
    const criada = await opcoes.criar();
    atividadeId = criada?.id ?? null;
    if (!idSeguro(atividadeId)) {
      throw new Error('ClickUp não devolveu um id válido para a atividade criada');
    }
    const registro = criarRegistro(atividadeId, opcoes.escopo, opcoes.agora);
    recuperacoesEmMemoria.set(opcoes.chaveOperacao, registro);
    try {
      await opcoes.storage.set({ [chave]: registro });
    } catch (erroStorage) {
      try {
        await opcoes.compensar(atividadeId);
        recuperacoesEmMemoria.delete(opcoes.chaveOperacao);
      } catch {
        try {
          await opcoes.storage.set({ [chave]: registro });
        } catch {
          // Retry in this process reuses the in-memory id.
        }
      }
      const erro = new Error('não foi possível reter a atividade criada para confirmação segura');
      (erro as Error & { status?: number }).status = 502;
      (erro as Error & { cause?: unknown }).cause = erroStorage;
      throw erro;
    }
  }

  return opcoes.confirmar(atividadeId);
}

export async function criarOuRecuperarAtividade<T>(opcoes: {
  storage: AtividadeKv;
  escopo: AtividadeEscopo;
  validar: () => Promise<void>;
  criar: () => Promise<{ id?: string } | null | undefined>;
  confirmar: (atividadeId: string) => Promise<T>;
  compensar: (atividadeId: string) => Promise<void>;
  agora?: number;
}): Promise<T> {
  const agora = opcoes.agora ?? Date.now();
  const chaveOperacao = digestEscopo(opcoes.escopo);
  if (emAndamento.has(chaveOperacao)) {
    return emAndamento.get(chaveOperacao) as Promise<T>;
  }
  const promessa = executar({ ...opcoes, agora, chaveOperacao }).finally(() => {
    emAndamento.delete(chaveOperacao);
  });
  emAndamento.set(chaveOperacao, promessa);
  return promessa;
}

export class MemoryAtividadeKv implements AtividadeKv {
  readonly dados = new Map<string, AtividadeRegistro>();
  private readonly failSet: boolean;

  constructor(opts: { failSet?: boolean } = {}) {
    this.failSet = Boolean(opts.failSet);
  }

  async get(chave: string) {
    return { [chave]: this.dados.get(chave) };
  }

  async set(objeto: Record<string, AtividadeRegistro>) {
    if (this.failSet) throw new Error('storage indisponível');
    for (const [chave, valor] of Object.entries(objeto)) this.dados.set(chave, valor);
  }

  async remove(chave: string) {
    this.dados.delete(chave);
  }
}

export type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...extras: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

const REDIS_PREFIX = 'clickup-inbox:';
export const ATIVIDADE_REDIS_TTL_SECONDS = Math.ceil(RECUPERACAO_TTL_MS / 1000);

export class RedisAtividadeKv implements AtividadeKv {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSeconds = ATIVIDADE_REDIS_TTL_SECONDS,
  ) {}

  private key(chave: string) {
    return `${REDIS_PREFIX}${chave}`;
  }

  async get(chave: string) {
    const bruto = await this.redis.get(this.key(chave));
    if (!bruto) return { [chave]: undefined };
    try {
      return { [chave]: JSON.parse(bruto) as AtividadeRegistro };
    } catch {
      return { [chave]: undefined };
    }
  }

  async set(objeto: Record<string, AtividadeRegistro>) {
    for (const [chave, valor] of Object.entries(objeto)) {
      await this.redis.set(this.key(chave), JSON.stringify(valor), 'EX', this.ttlSeconds);
    }
  }

  async remove(chave: string) {
    await this.redis.del(this.key(chave));
  }
}

export class MemoryRedis implements RedisLike {
  constructor(
    readonly dados = new Map<string, string>(),
    private readonly failSet = false,
  ) {}

  async get(key: string) {
    return this.dados.get(key) ?? null;
  }

  async set(key: string, value: string) {
    if (this.failSet) throw new Error('storage indisponível');
    this.dados.set(key, value);
    return 'OK';
  }

  async del(key: string) {
    this.dados.delete(key);
    return 1;
  }
}
