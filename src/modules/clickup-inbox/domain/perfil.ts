import { createHash } from 'crypto';
import { idSeguro } from './ids';

export type ClickUpInboxList = {
  id: string;
  label: string;
  primary: boolean;
};

export type ClickUpProjectList = {
  id: string;
  label: string;
};

export type ClickUpInboxActivities = {
  listId: string;
  relationFieldId: string;
};

export type ClickUpInboxProfile = {
  lists: ClickUpInboxList[];
  projectLists: ClickUpProjectList[];
  whatsappFieldId: string;
  blockedFieldIds: string[];
  tag: string | null;
  activities: ClickUpInboxActivities | null;
};

const LIST_KEYS = ['id', 'label', 'primary'];
const PROJECT_LIST_KEYS = ['id', 'label'];
const PROFILE_KEYS = [
  'lists',
  'projectLists',
  'whatsappFieldId',
  'blockedFieldIds',
  'tag',
  'activities',
];
const ACTIVITIES_KEYS = ['listId', 'relationFieldId'];

function extras(valor: unknown, permitidas: string[]): string[] {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return ['<invalid>'];
  return Object.keys(valor).filter((chave) => !permitidas.includes(chave));
}

function labelValido(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.trim().length > 0 && valor.length <= 160;
}

export function validarPerfil(perfil: unknown): { ok: true; profile: ClickUpInboxProfile } | { ok: false; erro: string } {
  if (!perfil || typeof perfil !== 'object' || Array.isArray(perfil)) {
    return { ok: false, erro: 'perfil inválido' };
  }
  if (extras(perfil, PROFILE_KEYS).length) {
    return { ok: false, erro: 'o perfil contém campos extras' };
  }
  const raw = perfil as Record<string, unknown>;
  if (!Array.isArray(raw.lists) || !Array.isArray(raw.blockedFieldIds)) {
    return { ok: false, erro: 'listas e campos bloqueados devem ser listas' };
  }
  if (raw.lists.length === 0) {
    return { ok: false, erro: 'selecione ao menos uma lista de leads' };
  }
  if (raw.lists.some((lista) => extras(lista, LIST_KEYS).length)) {
    return { ok: false, erro: 'uma lista contém campos extras' };
  }

  const lists: ClickUpInboxList[] = [];
  const seen = new Set<string>();
  for (const lista of raw.lists as Array<Record<string, unknown>>) {
    if (!idSeguro(lista?.id)) {
      return { ok: false, erro: 'o perfil contém uma lista inválida' };
    }
    if (!labelValido(lista.label)) {
      return { ok: false, erro: 'cada lista precisa de um rótulo textual' };
    }
    if (typeof lista.primary !== 'boolean') {
      return { ok: false, erro: 'primary deve ser boolean' };
    }
    if (seen.has(lista.id)) {
      return { ok: false, erro: 'o perfil contém listas duplicadas' };
    }
    seen.add(lista.id);
    lists.push({
      id: lista.id,
      label: lista.label.trim().slice(0, 160),
      primary: lista.primary,
    });
  }
  if (lists.filter((lista) => lista.primary).length !== 1) {
    return { ok: false, erro: 'deve existir exatamente uma lista principal' };
  }

  const projectLists: ClickUpProjectList[] = [];
  if (raw.projectLists != null) {
    if (!Array.isArray(raw.projectLists)) {
      return { ok: false, erro: 'projectLists deve ser uma lista' };
    }
    const seenProjects = new Set<string>();
    for (const lista of raw.projectLists as Array<Record<string, unknown>>) {
      if (extras(lista, PROJECT_LIST_KEYS).length) {
        return { ok: false, erro: 'uma lista de projeto contém campos extras' };
      }
      if (!idSeguro(lista?.id)) {
        return { ok: false, erro: 'o perfil contém uma lista de projeto inválida' };
      }
      if (!labelValido(lista.label)) {
        return { ok: false, erro: 'cada lista de projeto precisa de um rótulo textual' };
      }
      if (seenProjects.has(lista.id)) {
        return { ok: false, erro: 'o perfil contém listas de projeto duplicadas' };
      }
      seenProjects.add(lista.id);
      projectLists.push({
        id: lista.id,
        label: lista.label.trim().slice(0, 160),
      });
    }
  }

  if (!idSeguro(raw.whatsappFieldId)) {
    return { ok: false, erro: 'selecione um campo de telefone válido' };
  }

  if (!raw.blockedFieldIds.every((id) => typeof id === 'string' && idSeguro(id))) {
    return { ok: false, erro: 'o perfil contém um campo bloqueado inválido' };
  }
  const blockedFieldIds = raw.blockedFieldIds as string[];

  let activities: ClickUpInboxActivities | null = null;
  if (raw.activities != null) {
    if (extras(raw.activities, ACTIVITIES_KEYS).length) {
      return { ok: false, erro: 'atividades contém campos extras' };
    }
    const act = raw.activities as Record<string, unknown>;
    if (!idSeguro(act.listId) || !idSeguro(act.relationFieldId)) {
      return { ok: false, erro: 'lista de atividades e campo de relação devem aparecer juntos e válidos' };
    }
    activities = { listId: act.listId, relationFieldId: act.relationFieldId };
  }

  let tag: string | null = null;
  if (raw.tag != null && raw.tag !== '') {
    if (typeof raw.tag !== 'string') return { ok: false, erro: 'tag inválida' };
    tag = raw.tag.slice(0, 160);
  }

  return {
    ok: true,
    profile: {
      lists,
      projectLists,
      whatsappFieldId: raw.whatsappFieldId,
      blockedFieldIds,
      tag,
      activities,
    },
  };
}

export function listaPrincipal(profile: ClickUpInboxProfile): string {
  return profile.lists.find((lista) => lista.primary)!.id;
}

export function fingerprintPerfil(profile: ClickUpInboxProfile): string {
  const payload = {
    lists: profile.lists
      .map((lista) => [lista.id, Boolean(lista.primary)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
    projectLists: profile.projectLists.map((lista) => lista.id).sort(),
    whatsappFieldId: profile.whatsappFieldId,
    blocked: [...profile.blockedFieldIds].sort(),
    tag: profile.tag ?? '',
    activities: profile.activities,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
