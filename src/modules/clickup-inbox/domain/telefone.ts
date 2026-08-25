/**
 * Canonical BR phone for conversation ↔ ClickUp matching.
 * Form: DDI 55 + DDD(2) + last 8 subscriber digits.
 * Ported from Sidecard nucleo/telefone.js — semantics only.
 */

export const RECUSA = {
  VAZIO: 'vazio',
  CURTO: 'curto',
  NAO_BR: 'fora_do_padrao_br',
  GRUPO: 'grupo',
} as const;

export type RecusaMotivo = (typeof RECUSA)[keyof typeof RECUSA];

export type CanonicoOk = {
  ok: true;
  canonico: string;
  ddd: string;
  assinante: string;
};

export type CanonicoErro = {
  ok: false;
  motivo: RecusaMotivo;
  bruto: string;
};

export type CanonicoResult = CanonicoOk | CanonicoErro;

export function canonico(bruto: unknown): CanonicoResult {
  if (bruto === null || bruto === undefined) {
    return { ok: false, motivo: RECUSA.VAZIO, bruto: String(bruto) };
  }
  const texto = String(bruto).trim();
  if (texto === '') return { ok: false, motivo: RECUSA.VAZIO, bruto: texto };

  if (texto.includes('@g.us')) {
    return { ok: false, motivo: RECUSA.GRUPO, bruto: texto };
  }

  const digitos = texto.replace(/\D/g, '');
  if (digitos.length < 10) {
    return { ok: false, motivo: RECUSA.CURTO, bruto: texto };
  }

  const ddiExplicito = texto.trimStart().startsWith('+');
  if (ddiExplicito && !digitos.startsWith('55')) {
    return { ok: false, motivo: RECUSA.NAO_BR, bruto: texto };
  }

  const temPais = digitos.startsWith('55') && digitos.length >= 12;
  const comPais = temPais ? digitos : `55${digitos}`;
  const nacional = comPais.slice(2);

  if (nacional.length < 10 || nacional.length > 11) {
    return { ok: false, motivo: RECUSA.NAO_BR, bruto: texto };
  }

  const ddd = nacional.slice(0, 2);
  if (!/^[1-9][1-9]$/.test(ddd)) {
    return { ok: false, motivo: RECUSA.NAO_BR, bruto: texto };
  }

  const assinante = nacional.slice(-8);
  return { ok: true, canonico: `55${ddd}${assinante}`, ddd, assinante };
}

export function canonicoOuNull(bruto: unknown): string | null {
  const r = canonico(bruto);
  return r.ok ? r.canonico : null;
}
