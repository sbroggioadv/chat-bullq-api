import { Injectable } from '@nestjs/common';
import { ClickUpInboxConfigService } from './clickup-inbox-config.service';
import { ClickUpInboxHttpClient } from './clickup-inbox-http.client';
import type { LiveCatalogTree } from './domain/workbench';

export const CATALOG_TTL_MS = 10 * 60 * 1000;

export type CatalogCache = {
  tree: LiveCatalogTree;
  atualizadoEm: number;
  expiraEm: number;
};

@Injectable()
export class ClickUpCatalogService {
  private readonly caches = new Map<string, CatalogCache>();
  private readonly inflight = new Map<string, Promise<CatalogCache>>();

  constructor(
    private readonly config: ClickUpInboxConfigService,
    private readonly http: ClickUpInboxHttpClient,
  ) {}

  cacheKey(organizationId: string): string {
    return `${organizationId}:${this.config.fingerprint()}`;
  }

  peek(organizationId: string): CatalogCache | undefined {
    return this.caches.get(this.cacheKey(organizationId));
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  invalidate(organizationId: string) {
    this.caches.delete(this.cacheKey(organizationId));
  }

  async garantirArvore(
    organizationId: string,
    opts: { force?: boolean; now?: number } = {},
  ): Promise<CatalogCache> {
    const profile = this.config.profile();
    const now = opts.now ?? Date.now();
    if (profile.catalogSpaces.length === 0) {
      return {
        tree: { spaces: [] },
        atualizadoEm: now,
        expiraEm: now + CATALOG_TTL_MS,
      };
    }

    const key = this.cacheKey(organizationId);
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

  private async rebuild(key: string, now: number): Promise<CatalogCache> {
    const profile = this.config.profile();
    const tree = await this.http.catalogoDosSpaces(profile.catalogSpaces.map((space) => space.id));
    const cache: CatalogCache = {
      tree,
      atualizadoEm: now,
      expiraEm: now + CATALOG_TTL_MS,
    };
    this.caches.set(key, cache);
    return cache;
  }
}
