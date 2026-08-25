import { canonico, RECUSA } from './telefone';

export const STATUS = {
  UNICO: 'unico',
  AMBIGUO: 'ambiguo',
  SEM_CARD: 'sem_card',
  FORA_DO_PADRAO: 'fora_do_padrao',
  GRUPO: 'grupo',
} as const;

export type MatchStatus = (typeof STATUS)[keyof typeof STATUS];

export type CardIndexInput = {
  taskId: string;
  telefone: unknown;
};

export type IndiceMontado = {
  indice: Map<string, string[]>;
  ignorados: number;
};

export type MatchResult =
  | { status: typeof STATUS.GRUPO }
  | { status: typeof STATUS.FORA_DO_PADRAO; motivo: string; bruto: string }
  | { status: typeof STATUS.UNICO; canonico: string; taskId: string }
  | { status: typeof STATUS.AMBIGUO; canonico: string; taskIds: string[] }
  | { status: typeof STATUS.SEM_CARD; canonico: string };

export function montarIndice(cards: CardIndexInput[]): IndiceMontado {
  const indice = new Map<string, string[]>();
  let ignorados = 0;

  for (const card of cards) {
    const r = canonico(card.telefone);
    if (!r.ok) {
      ignorados += 1;
      continue;
    }
    const atual = indice.get(r.canonico);
    if (atual) atual.push(card.taskId);
    else indice.set(r.canonico, [card.taskId]);
  }
  return { indice, ignorados };
}

export function resolver(jidOuTelefone: unknown, indice: Map<string, string[]>): MatchResult {
  const r = canonico(jidOuTelefone);

  if (!r.ok) {
    if (r.motivo === RECUSA.GRUPO) return { status: STATUS.GRUPO };
    return { status: STATUS.FORA_DO_PADRAO, motivo: r.motivo, bruto: r.bruto };
  }

  const taskIds = indice.get(r.canonico) ?? [];
  if (taskIds.length === 1) {
    return { status: STATUS.UNICO, canonico: r.canonico, taskId: taskIds[0] };
  }
  if (taskIds.length > 1) {
    return { status: STATUS.AMBIGUO, canonico: r.canonico, taskIds };
  }
  return { status: STATUS.SEM_CARD, canonico: r.canonico };
}

export function colisoes(indice: Map<string, string[]>) {
  const saida: Array<{ canonico: string; taskIds: string[] }> = [];
  for (const [canon, taskIds] of indice) {
    if (taskIds.length > 1) saida.push({ canonico: canon, taskIds });
  }
  return saida;
}
