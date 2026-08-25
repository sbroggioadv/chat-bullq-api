export const WORKBENCH_STATUS = {
  SEM_VINCULO: 'sem_vinculo',
  TASK_VINCULADA: 'task_vinculada',
  BINDING_INVALIDO: 'binding_invalido',
} as const;

export type WorkbenchStatus = (typeof WORKBENCH_STATUS)[keyof typeof WORKBENCH_STATUS];

export type CatalogShortcut = {
  id: string;
  label: string;
  kind: 'sales' | 'project';
};

export function catalogoAtalhos(profile: {
  lists: Array<{ id: string; label: string }>;
  projectLists: Array<{ id: string; label: string }>;
}): CatalogShortcut[] {
  const seen = new Set<string>();
  const out: CatalogShortcut[] = [];
  for (const lista of profile.lists) {
    if (seen.has(lista.id)) continue;
    seen.add(lista.id);
    out.push({ id: lista.id, label: lista.label, kind: 'sales' });
  }
  for (const lista of profile.projectLists) {
    if (seen.has(lista.id)) continue;
    seen.add(lista.id);
    out.push({ id: lista.id, label: lista.label, kind: 'project' });
  }
  return out;
}

export function idsCatalogoAtalhos(profile: {
  lists: Array<{ id: string }>;
  projectLists: Array<{ id: string }>;
}): Set<string> {
  const ids = new Set<string>();
  for (const lista of profile.lists) ids.add(lista.id);
  for (const lista of profile.projectLists) ids.add(lista.id);
  return ids;
}

export type LiveCatalogList = {
  id: string;
  label: string;
};

export type LiveCatalogFolder = {
  id: string;
  label: string;
  lists: LiveCatalogList[];
};

export type LiveCatalogSpace = {
  id: string;
  label: string;
  folders: LiveCatalogFolder[];
  lists: LiveCatalogList[];
};

export type LiveCatalogTree = {
  spaces: LiveCatalogSpace[];
};

export function idsCatalogoLive(tree: LiveCatalogTree | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!tree) return ids;
  for (const space of tree.spaces) {
    for (const lista of space.lists) ids.add(lista.id);
    for (const folder of space.folders) {
      for (const lista of folder.lists) ids.add(lista.id);
    }
  }
  return ids;
}

export function idsCatalogoUniao(
  profile: {
    lists: Array<{ id: string }>;
    projectLists: Array<{ id: string }>;
  },
  tree?: LiveCatalogTree | null,
): Set<string> {
  const ids = idsCatalogoAtalhos(profile);
  for (const id of idsCatalogoLive(tree)) ids.add(id);
  return ids;
}

export function listsDoSpace(tree: LiveCatalogTree, spaceId: string): string[] {
  const space = tree.spaces.find((item) => item.id === spaceId);
  if (!space) return [];
  const ids: string[] = [];
  for (const lista of space.lists) ids.push(lista.id);
  for (const folder of space.folders) {
    for (const lista of folder.lists) ids.push(lista.id);
  }
  return ids;
}
