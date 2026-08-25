export const GROUP_STATUS = {
  TASK_VINCULADA: 'task_vinculada',
  BINDING_INVALIDO: 'binding_invalido',
  SEM_VINCULO: 'sem_vinculo',
} as const;

export type GroupStatus = (typeof GROUP_STATUS)[keyof typeof GROUP_STATUS];

export function catalogoProjeto(profile: { projectLists: Array<{ id: string; label: string }> }) {
  return profile.projectLists.map((lista) => ({ id: lista.id, label: lista.label }));
}

export function idsCatalogoProjeto(profile: { projectLists: Array<{ id: string }> }): Set<string> {
  return new Set(profile.projectLists.map((lista) => lista.id));
}
