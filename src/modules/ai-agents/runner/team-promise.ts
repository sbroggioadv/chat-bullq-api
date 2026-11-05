/** Deterministic sentence-level commitments, excluding offers and questions. */
export function promisesTeamContact(text: string): boolean {
  const normalized = text.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')
    .replace(/\b(dr|dra)\./g, '$1');
  const destination = /\b(?:equipe|time|advogad[oa]s?|dr[a]? [a-z]+)\b/;
  const action = /\b(?:acion|cham|avis|notific|encaminh|pass|repass|ped|pec|solicit|fal|retorn|entr|procur)[a-z]*\b/;
  const pastOrFuture = /\b(?:(?:acion|cham|avis|notific|encaminh|pass|repass|solicit|fal|retorn|entr|procur)(?:ei|ou|aram|amos|ara[a-z]*|arei|aremos)|ped(?:i|iu|iram|imos|ira[a-z]*))\b/;
  const commitment = /\b(?:vou|vamos|vai|vao|foi|foram|estou|estamos|esta|estao)\b|\b(?:acionei|chamei|avisei|notifiquei|encaminhei|passei|repassei|pedi|solicitei|falei|retornei|entrei|procurei|acionara|chamara|avisara|notificara|encaminhara|passara|repassara|pedira|solicitara|falara|retornara|entrara|procurara)[a-z]*\b/;
  return (normalized.match(/[^.!;?]+(?:[.!;?]|$)/g) ?? []).some((raw) => {
    const sentence = raw.trim().replace(/,\s*(?:ta|ok)\?$/, '');
    if (!sentence || sentence.includes('?')) return false;
    if (/\b(?:nao|posso|podemos|pode|podem|poderia|quer que|se quiser|se voce quiser|se preferir|se voce preferir|se a equipe|quando precisa)\b/.test(sentence)) return false;
    if (/\bseu caso (?:ja )?esta com a equipe\b/.test(sentence)) return true;
    return destination.test(sentence) && action.test(sentence) && (commitment.test(sentence) || pastOrFuture.test(sentence));
  });
}
