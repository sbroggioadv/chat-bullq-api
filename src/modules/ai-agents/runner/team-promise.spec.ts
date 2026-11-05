import { promisesTeamContact } from './team-promise';

const NON_PROMISES = [
  'A equipe avalia cada caso individualmente. Me conta brevemente o que está acontecendo.',
  'Se quiser uma avaliação formal pelo escritório, posso te conectar com a Dra. Fulana nossa especialista.',
  'Sou o assistente do escritório, e o Dr. Fulano e a equipe acompanham tudo por aqui.',
  'Os honorários são definidos caso a caso, depois que o Dr. Fulano avalia sua situação na reunião inicial. Quer agendar uma conversa?',
  'O escritório não atua na área criminal. Mas posso te indicar um colega de confiança que trabalha com isso. Quer que eu faça essa indicação?',
  'De segunda a sexta, das 9h às 18h, horário de Brasília.',
  'Se preferir, posso pedir para a equipe te chamar.',
];

describe('promisesTeamContact', () => {
  it.each(['Sobre os documentos, como o prazo é amanhã, vou acionar a equipe agora pra te orientar o quanto antes.', 'Entendi a urgência. A equipe já foi avisada e vai te procurar em breve pra tratar do prazo.', 'Entendido, a equipe já foi acionada e vai te procurar pra tratar da contestação.', 'Vou chamar alguém da equipe pra falar com você.', 'Vou passar seu caso para a equipe.', 'Já encaminhei para o Dr. Fulano.', 'A equipe vai entrar em contato com você.', 'Um advogado vai te retornar.'])('reconhece: %s', (text) => {
    expect(promisesTeamContact(text)).toBe(true);
    expect(promisesTeamContact(text.toUpperCase())).toBe(true);
  });
  it.each(NON_PROMISES)('não confunde oferta com promessa: %s', (text) => {
    expect(promisesTeamContact(text)).toBe(false);
  });
});

const table = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'team-promise-r7.json'), 'utf8'));
it.each(table.promessas)('tabela R7 promessa: %s', (text: string) => expect(promisesTeamContact(text)).toBe(true));
it.each(table.nao_promessas)('tabela R7 não promessa: %s', (text: string) => expect(promisesTeamContact(text)).toBe(false));
it('avalia frases separadas e preserva títulos', () => {
  expect(promisesTeamContact('Posso ajudar? Vou avisar a Dra. Fulana.')).toBe(true);
  expect(promisesTeamContact('Não vou chamar a equipe. Já avisei o Dr. Fulano.')).toBe(true);
});
it.each([
  'A equipe chamou você.', 'Nossa equipe avisou o Dr. Fulano.',
  'O time solicitou retorno.', 'Uma advogada pediu contato.',
  'Os advogados encaminharam seu pedido.', 'A equipe está entrando em contato.',
  'A equipe vai avisar. Não precisa responder.',
])('flexões gerais de tempo e sujeito: %s', (text) => expect(promisesTeamContact(text)).toBe(true));
it.each(['A equipe vai retornar? Me avise.', 'Não é que a Dra. Fulana foi avisada.', 'Pode entrar em contato com a equipe.'])('preserva pergunta e negação: %s', (text) => expect(promisesTeamContact(text)).toBe(false));
