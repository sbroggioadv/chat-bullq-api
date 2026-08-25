export const LINHA_ECO = '🔄 registro automático do inbox · não responder aqui';

export function montarComentario(input: {
  oQue: string;
  quem: string;
  proximoPasso: string;
}): string {
  return [
    LINHA_ECO,
    '',
    input.oQue,
    '',
    `Quem fez: ${input.quem || 'operador'} · via inbox`,
    `Próximo passo: ${input.proximoPasso || '[COMPLETAR]'}`,
  ].join('\n');
}

const PROIBIDO = [/\bmargem\b/i, /\bdesconto de\b/i, /\bcusto\b/i];

export function pareceSensivel(texto: string): boolean {
  return PROIBIDO.some((r) => r.test(texto ?? ''));
}

export function comentarioSensivel(input: { oQue: string; proximoPasso: string; quem?: string }): boolean {
  return pareceSensivel(input.oQue)
    || pareceSensivel(input.proximoPasso)
    || pareceSensivel(montarComentario({
      oQue: input.oQue,
      quem: input.quem || 'operador',
      proximoPasso: input.proximoPasso,
    }));
}
