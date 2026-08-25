import { ConfigService } from '@nestjs/config';
import { CATALOG_TTL_MS, ClickUpCatalogService } from './clickup-catalog.service';
import { ClickUpInboxConfigService } from './clickup-inbox-config.service';
import { ClickUpInboxHttpClient } from './clickup-inbox-http.client';
import {
  createClickUpFetch,
  emptyLiveCatalogStore,
  LIVE_CATALOG_PROFILE,
  workbenchEnv,
} from './clickup-inbox.test-harness';

function catalogFor(org = 'org-a', store = emptyLiveCatalogStore()) {
  const env = workbenchEnv(LIVE_CATALOG_PROFILE);
  env.CLICKUP_ORGANIZATION_ID = org;
  const config = new ClickUpInboxConfigService({
    get: (k: string) => env[k],
  } as ConfigService);
  const fetchFn = createClickUpFetch(store);
  const http = new ClickUpInboxHttpClient(config, fetchFn as any);
  const catalog = new ClickUpCatalogService(config, http);
  return { catalog, fetchFn, store, config };
}

function spaceCalls(fetchFn: jest.Mock) {
  return fetchFn.mock.calls.filter((c: any) => String(c[0]).includes('/space/'));
}

describe('ClickUp catalog cache (W1)', () => {
  it('sem catalogSpaces não chama ClickUp', async () => {
    const env = workbenchEnv();
    const config = new ClickUpInboxConfigService({
      get: (k: string) => env[k],
    } as ConfigService);
    const fetchFn = jest.fn();
    const http = new ClickUpInboxHttpClient(config, fetchFn as any);
    const catalog = new ClickUpCatalogService(config, http);
    const out = await catalog.garantirArvore('org-a');
    expect(out.tree.spaces).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('monta árvore space → folder → list e coalese/TTL 10 min', async () => {
    const { catalog, fetchFn } = catalogFor();
    const first = await catalog.garantirArvore('org-a', { now: 1_000 });
    expect(first.tree.spaces.map((space) => space.id)).toEqual([
      'space-comercial',
      'space-projetos',
    ]);
    const projetos = first.tree.spaces.find((space) => space.id === 'space-projetos')!;
    expect(projetos.lists.some((lista) => lista.label === 'Consultivo')).toBe(true);
    expect(projetos.folders[0]?.lists.some((lista) => lista.id === 'list-iniciais-live')).toBe(
      true,
    );
    const hits = spaceCalls(fetchFn).length;

    const cached = await catalog.garantirArvore('org-a', { now: 1_000 + CATALOG_TTL_MS - 1 });
    expect(cached.tree).toBe(first.tree);
    expect(spaceCalls(fetchFn).length).toBe(hits);

    await catalog.garantirArvore('org-a', { now: 1_000 + CATALOG_TTL_MS + 1 });
    expect(spaceCalls(fetchFn).length).toBeGreaterThan(hits);
  });

  it('falha de um space não publica árvore parcial', async () => {
    const store = emptyLiveCatalogStore();
    store.failCatalogSpace = 'space-projetos';
    const { catalog } = catalogFor('org-a', store);
    await expect(catalog.garantirArvore('org-a')).rejects.toBeTruthy();
    expect(catalog.peek('org-a')).toBeUndefined();
  });

  it('AC-09 cache de org A não atende org B', async () => {
    const store = emptyLiveCatalogStore();
    const { catalog, fetchFn } = catalogFor('org-a', store);
    await catalog.garantirArvore('org-a');
    const hitsA = spaceCalls(fetchFn).length;
    await catalog.garantirArvore('org-b');
    expect(spaceCalls(fetchFn).length).toBeGreaterThan(hitsA);
    expect(catalog.peek('org-a')).toBeDefined();
    expect(catalog.peek('org-b')).toBeDefined();
    expect(catalog.cacheKey('org-a')).not.toBe(catalog.cacheKey('org-b'));
  });

  it('duas chamadas paralelas coalescem num rebuild', async () => {
    const { catalog, fetchFn } = catalogFor();
    await Promise.all([catalog.garantirArvore('org-a'), catalog.garantirArvore('org-a')]);
    const folderGets = fetchFn.mock.calls.filter((c: any) =>
      /\/space\/space-(comercial|projetos)\/folder/.test(String(c[0])),
    );
    expect(folderGets.length).toBe(2);
  });
});
