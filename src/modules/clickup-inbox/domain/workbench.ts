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
