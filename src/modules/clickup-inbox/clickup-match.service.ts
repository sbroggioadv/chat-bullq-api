import { Injectable } from '@nestjs/common';
import { montarIndice, resolver, type MatchResult } from './domain/casamento';
import { ClickUpInboxConfigService } from './clickup-inbox-config.service';
import { ClickUpInboxHttpClient } from './clickup-inbox-http.client';

export const INDEX_TTL_MS = 10 * 60 * 1000;

export type IndexCache = {
  indice: Map<string, string[]>;
  total: number;
  ignorados: number;
  atualizadoEm: number;
  expiraEm: number;
};

@Injectable()
export class ClickUpMatchService {
  private readonly caches = new Map<string, IndexCache>();
  private readonly inflight = new Map<string, Promise<IndexCache>>();

  constructor(
    private readonly config: ClickUpInboxConfigService,
    private readonly http: ClickUpInboxHttpClient,
  ) {}

  cacheKey(organizationId: string): string {
    return `${organizationId}:${this.config.fingerprint()}`;
  }

  peek(organizationId: string): IndexCache | undefined {
    return this.caches.get(this.cacheKey(organizationId));
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  invalidate(organizationId: string) {
    this.caches.delete(this.cacheKey(organizationId));
  }

  async garantirIndice(
    organizationId: string,
    opts: { force?: boolean; now?: number } = {},
  ): Promise<IndexCache> {
    const key = this.cacheKey(organizationId);
    const now = opts.now ?? Date.now();
    if (!opts.force) {
      const existing = this.caches.get(key);
      if (existing && existing.expiraEm > now) return existing;
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }
    const promise = this.rebuild(key, now).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async resolverTelefone(
    organizationId: string,
    telefone: unknown,
    opts: { force?: boolean } = {},
  ): Promise<MatchResult & { cache: IndexCache }> {
    const cache = await this.garantirIndice(organizationId, opts);
    return { ...resolver(telefone, cache.indice), cache };
  }

  private async rebuild(key: string, now: number): Promise<IndexCache> {
    const profile = this.config.profile();
    const cards: Array<{ taskId: string; telefone: unknown }> = [];
    for (const lista of profile.lists) {
      const tarefas = await this.http.tarefasDaLista(lista.id);
      for (const task of tarefas) {
        if (profile.tag && !(task.tags ?? []).some((tag: { name?: string }) => tag.name === profile.tag)) {
          continue;
        }
        const telefone =
          (task.custom_fields ?? []).find(
            (campo: { id?: string }) => campo.id === profile.whatsappFieldId,
          )?.value ?? null;
        cards.push({ taskId: String(task.id), telefone });
      }
    }
    const montado = montarIndice(cards);
    const cache: IndexCache = {
      indice: montado.indice,
      total: cards.length,
      ignorados: montado.ignorados,
      atualizadoEm: now,
      expiraEm: now + INDEX_TTL_MS,
    };
    this.caches.set(key, cache);
    return cache;
  }
}
