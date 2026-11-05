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
