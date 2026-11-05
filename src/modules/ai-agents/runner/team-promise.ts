/** Explicit commitments only; offers such as "posso pedir" are not promises. */
export function promisesTeamContact(text: string): boolean {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return [
    /\bvou (?:acionar|chamar|avisar) (?:a equipe|alguem da equipe)\b/,
    /\ba equipe (?:ja )?foi (?:avisada|acionada)\b/,
    /\bvou passar seu caso para a equipe\b/,
    /\bja encaminhei para (?:o dr\.|a dra\.|a equipe)\s/,
    /\ba equipe vai entrar em contato\b/,
    /\bum advogad[oa] vai te retornar\b/,
  ].some((pattern) => pattern.test(normalized));
}
