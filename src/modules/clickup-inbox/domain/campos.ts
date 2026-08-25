export const WRITABLE_FIELD_TYPES = [
  'drop_down',
  'labels',
  'date',
  'currency',
  'email',
  'phone',
  'url',
  'short_text',
  'text',
] as const;

export const READONLY_FIELD_TYPES = [
  'users',
  'list_relationship',
  'checkbox',
  'number',
] as const;

export type WritableFieldType = (typeof WRITABLE_FIELD_TYPES)[number];

export type FieldOption = {
  id: string;
  rotulo: string;
  cor: string | null;
};

export type CampoMeta = {
  id: string;
  nome: string;
  tipo: string;
  opcoes: FieldOption[];
  moeda: string | null;
};

export type CampoCard = CampoMeta & {
  valor: unknown;
  valorInput: unknown;
  writable: boolean;
};

const WRITABLE = new Set<string>(WRITABLE_FIELD_TYPES);

export function isWritableType(tipo: string): tipo is WritableFieldType {
  return WRITABLE.has(tipo);
}

export function fieldValueForInput(campo: {
  tipo: string;
  valor: unknown;
  opcoes: FieldOption[];
}): unknown {
  const v = campo.valor;
  if (v === null || v === undefined) return campo.tipo === 'labels' ? [] : '';
  if (campo.tipo === 'date') {
    const n = Number(v);
    return Number.isFinite(n) ? new Date(n).toISOString().slice(0, 10) : '';
  }
  if (campo.tipo === 'drop_down') {
    const i = Number(v);
    if (Number.isInteger(i) && campo.opcoes[i]) return campo.opcoes[i].id;
    return String(v);
  }
  if (campo.tipo === 'labels') return Array.isArray(v) ? v : [];
  return String(v);
}

export type SerializeOk = { ok: true; value: unknown };
export type SerializeErr = { ok: false; erro: string };

export function serializeFieldValue(tipo: string, value: unknown): SerializeOk | SerializeErr {
  if (!isWritableType(tipo)) {
    return { ok: false, erro: 'tipo de campo não é gravável nesta wave' };
  }
  if (value === null || value === undefined || value === '') {
    return { ok: true, value: null };
  }

  if (tipo === 'labels') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      return { ok: false, erro: 'labels exige um array de ids' };
    }
    return { ok: true, value: value.map(String) };
  }

  if (tipo === 'date') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { ok: true, value: String(value) };
    }
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const ms = new Date(`${value}T12:00:00-03:00`).getTime();
      if (!Number.isFinite(ms)) return { ok: false, erro: 'data inválida' };
      return { ok: true, value: String(ms) };
    }
    return { ok: false, erro: 'data deve ser YYYY-MM-DD' };
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    return { ok: false, erro: 'valor inválido para o tipo' };
  }
  const trimmed = String(value).trim();
  if (trimmed === '') return { ok: true, value: null };
  return { ok: true, value: trimmed };
}

export function montarCampoCard(
  meta: CampoMeta,
  valor: unknown,
  blocked: Set<string>,
): CampoCard {
  return {
    ...meta,
    valor,
    valorInput: fieldValueForInput({ tipo: meta.tipo, valor, opcoes: meta.opcoes }),
    writable: isWritableType(meta.tipo) && !blocked.has(meta.id),
  };
}
