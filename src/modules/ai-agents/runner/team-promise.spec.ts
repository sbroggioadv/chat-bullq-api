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
it.each(['A equipe chamou você.', 'A equipe está entrando em contato.'])('flexões de contato: %s', text => expect(promisesTeamContact(text)).toBe(true));
// R8: equipe precisa ter verbo de contato; sujeito indefinido não basta.
it.each([
  'Nossa equipe avisou o Dr. Fulano.', 'O time solicitou retorno.',
  'Uma advogada pediu contato.', 'Os advogados encaminharam seu pedido.',
  'A equipe vai avisar. Não precisa responder.',
])('R8 corrige generalizações R7: %s', text => expect(promisesTeamContact(text)).toBe(false));
it.each(['A equipe vai retornar? Me avise.', 'Não é que a Dra. Fulana foi avisada.', 'Pode entrar em contato com a equipe.'])('preserva pergunta e negação: %s', (text) => expect(promisesTeamContact(text)).toBe(false));

const tableR8 = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'team-promise-r8.json'), 'utf8'));
it.each(tableR8.promessas)('tabela R8 promessa: %s', (text: string) => expect(promisesTeamContact(text)).toBe(true));
it.each(tableR8.nao_promessas)('tabela R8 não promessa: %s', (text: string) => expect(promisesTeamContact(text)).toBe(false));

describe('R8 estruturas e exclusões fora das tabelas', () => {
  it.each([
    'Vou notificar a equipe para não perder o prazo.', 'Nossos advogados estão cientes.', 'Irei informar nossa equipe sobre isso.', 'Confirmo com o nosso advogado.',
    'Estamos enviando sua mensagem para uma pessoa da equipe.',
    'Em breve o pessoal vai cuidar do seu atendimento.', 'Nosso advogado lhe responderá.',
    'Nossos advogados foram informados.', 'O time está sabendo disso.',
    'Sua solicitação foi repassada para nosso time.', 'Isso ficou com alguém do escritório.',
    'Entraremos em contato amanhã.', 'Retornaremos por aqui.', 'Te retornamos logo.',
    'Deixa comigo, notificarei a equipe.', 'Tranquilo, avisamos o time.',
    'Aguarde, vou consultar a doutora.', 'Vou avisar a equipe, ok?',
    'Não vou avisar a equipe, já transferi para nosso time.',
  ])('detecta %s', text => expect(promisesTeamContact(text)).toBe(true));
  it.each([
    'Vou deixar o pedido longe da equipe.', 'Vou falar sobre a equipe.', 'Vou colocar seu caso para a equipe.', 'O gerente vai avisar nossa equipe.', 'Eu vou explicar como o time atende.',
    'O time comercial vai te ligar.', 'A equipe da franqueadora foi avisada.',
    'A Dra. Fulana, juíza do caso, foi informada.', 'Um advogado vai entrar com recurso.',
    'Ainda não avisei nosso time.', 'Seu contato não está com o time ainda.',
    'Ninguém vai chamar a equipe.', 'Nenhum advogado vai te retornar.',
    'Não precisa avisar nossa equipe.', 'Não consigo consultar o doutor.',
    'A equipe não foi notificada.', 'Só vou avisar a equipe se você autorizar.',
    'Podemos avisar nosso time.', 'Poderia avisar nossa equipe.',
    'Prefere que eu chame o time.', 'Se quiser, vou avisar nossa equipe.',
    'Se preferir, a equipe vai te ligar.', 'Se precisar, vou chamar nosso time.',
    'Caso precise, vou consultar o doutor.', 'Quando terminar, a equipe vai te ligar.',
    'Para falar com o time, envie o documento.', 'Antes de avisar o time, preciso do arquivo.',
    'Sem isso, vou avisar a equipe.', 'Entre em contato com nosso advogado.',
    'Vou te chamar de Exemplo.', 'A equipe vai te ligar, certo?',
  ])('rejeita %s', text => expect(promisesTeamContact(text)).toBe(false));
});
