import { montarIndice, resolver, STATUS } from './casamento';

describe('casamento (AC-03)', () => {
  it('índice contém somente taskIds e preserva ambiguidade', () => {
    const cards = [
      {
        taskId: 'a1',
        nome: 'Pessoa A',
        telefone: '+55 11 99876-5432',
        email: 'a@example.test',
        url: 'https://clickup.test/a',
        status: 'novo',
      },
      {
        taskId: 'b2',
        nome: 'Pessoa B',
        telefone: '11 9876-5432',
        email: 'b@example.test',
        url: 'https://clickup.test/b',
        status: 'novo',
      },
    ];
    const montado = montarIndice(cards);
    expect(montado.indice.get('551198765432')).toEqual(['a1', 'b2']);
    const resposta = resolver('+55 11 99876-5432', montado.indice);
    expect(resposta.status).toBe(STATUS.AMBIGUO);
    expect(resposta.status === STATUS.AMBIGUO && resposta.taskIds).toEqual(['a1', 'b2']);
    expect(JSON.stringify([...montado.indice.entries()]).includes('example.test')).toBe(false);
  });

  it('índice vazio é sem_card; um card é unico; zero não inventa', () => {
    const vazio = montarIndice([]);
    expect(vazio.indice.size).toBe(0);
    expect(resolver('11 99876-5432', vazio.indice).status).toBe(STATUS.SEM_CARD);

    const unico = montarIndice([{ taskId: 'only-1', telefone: '11 99876-5432' }]);
    expect(resolver('11 99876-5432', unico.indice)).toEqual(
      expect.objectContaining({ status: STATUS.UNICO, taskId: 'only-1' }),
    );
  });
});
