/** Pure structural recognition of commitments to the office's attendants. */
const TEAM = String.raw`(?:a equipe|nossa equipe|o time|nosso time|alguem(?: d[ao] (?:equipe|time|escritorio))?|uma pessoa da equipe|o pessoal(?: d[ao] (?:equipe|escritorio))?|um advogado(?: da equipe)?|uma advogada(?: da equipe)?|um (?:dos|de) nossos advogados|nossos advogados|nosso advogado|o dr [a-z]+|a dra [a-z]+|o doutor|a doutora)(?![a-z]| (?:de vendas|comercial|financeira|de gestao|da empresa|da loja|da franqueadora)\b)`;
const PREFIX = String.raw`(?:(?:eu|nos|ja|agora|logo|em breve|te|lhe) )*`;
const ACTION_STEMS = ['acion', 'cham', 'avis', 'inform', 'notific', 'encaminh', 'mand', 'envi', 'pass', 'repass', 'transfer', 'direcion', 'conect', 'coloc', 'deix', 'ped', 'solicit', 'fal', 'v', 'verific', 'confirm', 'consult'];
const FIRST_PERSON = [
  ...ACTION_STEMS.filter(stem => !['transfer', 'ped', 'v'].includes(stem)).map(stem => `${stem}(?:o|ei|amos|arei|aremos)`),
  'coloquei', 'coloquemos', 'transfiro', 'transferi', 'transferimos', 'transferirei', 'transferiremos',
  'peco', 'pedi', 'pedimos', 'pedirei', 'pediremos', 'vejo', 'vi', 'vimos', 'verei', 'veremos',
].join('|');
const INFINITIVE_OR_GERUND = String.raw`(?:acion|cham|avis|inform|notific|encaminh|mand|envi|pass|repass|direcion|conect|coloc|deix|solicit|fal|verific|confirm|consult)(?:ar|ando)|transfer(?:ir|indo)|ped(?:ir|indo)|ver|vendo`;
const DESTINATION = String.raw`(?: [a-z]+){0,4} (?:${TEAM})\b`;

// 1. First-person action whose nearby destination is an attendant.
function assistantActsOnTeam(clause: string): boolean {
  const action = String.raw`(?:(?:vou|vamos|irei|estou|estamos) (?:te |lhe )?(?:${INFINITIVE_OR_GERUND})|${FIRST_PERSON})`;
  const match = new RegExp(`^${PREFIX}(${action})(${DESTINATION})`).exec(clause);
  if (!match) return false;
  const verb = match[1].split(' ').pop()!;
  if (/^(?:coloc|coloqu)/.test(verb)) return / em contato com /.test(match[2]);
  if (/^deix/.test(verb)) return / com /.test(match[2]) || /\bciente\b/.test(clause.slice(match[0].length));
  if (/^(?:fal|vejo|vi$|vimos|ver|vendo|confirm)/.test(verb)) return / com /.test(match[2]);
  return true;
}

// 2. Attendant subject followed by a contact verb, never a legal action.
function teamContactsPerson(clause: string): boolean {
  const contact = String.raw`(?:(?:cham|procur|lig|respond|retorn|atend|assum|cuid)[a-z]*|(?:dar|da|dara|deu|dando) retorno|(?:fal[a-z]* com voce)|entr[a-z]* em contato)`;
  const match = new RegExp(`^${PREFIX}(${TEAM}) ((?:(?:ja|logo|vai|irao|ira|vao|deve|devem|te|lhe|esta|estao) )*)(${contact})\\b(.*)$`).exec(clause);
  if (!match) return false;
  // Generic opening hours and descriptions of service are not commitments.
  return !/\b(?:das? \d|as \d|de segunda\b|caso a caso\b|cada caso\b|horario\b)/.test(match[4]);
}

// 3. Attendant subject in a notified/aware state.
function teamAlreadyKnows(clause: string): boolean {
  return new RegExp(`^${PREFIX}${TEAM} (?:ja )?(?:(?:foi|foram) (?:acionad|avisad|chamad|notificad|informad)[oa]s?|esta(?:o)? (?:cientes?|sabendo))\\b`).test(clause);
}

// 4. The person's case/message/contact has been handed to an attendant.
function caseIsWithTeam(clause: string): boolean {
  return new RegExp(`^(?:(?:seu (?:caso|contato|pedido)|sua (?:solicitacao|mensagem)|isso|agora) )?(?:ja )?(?:foi (?:encaminhad|passad|repassad)[oa]|esta|ficou) (?:com|para|a) ${TEAM}\\b`).test(clause);
}

// 5. First-person plural return on behalf of the office.
function officePromisesReturn(clause: string): boolean {
  return /^(?:ja )?(?:vamos (?:te retornar|entrar em contato)|entraremos em contato|retornaremos|te retornamos)\b/.test(clause);
}

function excludedClause(clause: string): boolean {
  return new RegExp(`^${PREFIX}(?:ainda )?nao\\b|^${PREFIX}${TEAM} (?:ainda )?nao\\b`).test(clause)
    || /\b(?:ninguem|nenhum|posso|podemos|pode|podem|poderia|quer que|prefere que|se quiser|se preferir|se precisar|caso precise|se a equipe|antes de|sem isso)\b/.test(clause)
    || /^(?:quando|para falar|so\b.*\bse)\b/.test(clause);
}

function sentencePromises(raw: string): boolean {
  const sentence = raw.trim().replace(/,\s*(?:ta|ok)\?$/, '');
  if (!sentence || sentence.includes('?')) return false;
  // Keep qualifications attached before splitting clauses: a titled expert can
  // be a third party rather than someone who attends for this office.
  const scoped = sentence.replace(/\b(?:o dr|a dra) [a-z]+,\s*(?:perit[oa]|juiz[a]?|advogad[oa] deles)\b/g, 'terceiro')
    .replace(/\b(pedir|solicitar|pedi|solicitei) que\b/g, '$1 para');
  const clauses = scoped.split(/,|\bque\b/);
  let dependentExcluded = false;
  return clauses.some(rawClause => {
    const clause = rawClause.trim();
    if (/^(?:pode deixar|deixa comigo|nao se preocupe|fique tranquilo|tranquilo|aguarde)$/.test(clause)) return false;
    // A conditional/negative introduction governs its following subordinate.
    if (/^(?:se\b|caso precise|quando\b|sem isso|nao e|quer$|prefere$)/.test(clause)) dependentExcluded = true;
    if (dependentExcluded || excludedClause(clause)) return false;
    return assistantActsOnTeam(clause) || teamContactsPerson(clause)
      || teamAlreadyKnows(clause) || caseIsWithTeam(clause) || officePromisesReturn(clause);
  });
}

export function promisesTeamContact(text: string): boolean {
  const normalized = text.toLowerCase().replace(/à(?=\s)/g, 'para a').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')
    .replace(/\b(dr|dra)\./g, '$1')
    .replace(/\bao\b/g, 'a o').replace(/\bpro\b/g, 'para o');
  return (normalized.match(/[^.!;?]+(?:[.!;?]|$)/g) ?? []).some(sentencePromises);
}
