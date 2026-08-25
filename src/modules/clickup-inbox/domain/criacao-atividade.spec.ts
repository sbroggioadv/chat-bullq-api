import {
  criarOuRecuperarAtividade,
  limparRecuperacoesAtividade,
  MemoryAtividadeKv,
} from './criacao-atividade';

const escopo = {
  organizationId: 'org-a',
  taskId: 'task-1',
  listaId: 'list-acts',
  campoId: 'field-rel',
  nome: 'Retorno importante',
  dueDate: null,
};

describe('criação de atividade (AC-07)', () => {
  beforeEach(() => limparRecuperacoesAtividade());

  it('retry recupera o id confirmado sem duplicar a criação', async () => {
    const storage = new MemoryAtividadeKv();
    let criacoes = 0;
    let confirmacoes = 0;
    const opcoes = {
      storage,
      escopo,
      validar: async () => undefined,
      criar: async () => {
        criacoes += 1;
        return { id: 'atividade-1' };
      },
      confirmar: async (atividadeId: string) => {
        confirmacoes += 1;
        if (confirmacoes === 1) throw new Error('confirmação temporariamente indisponível');
        return { atividadeId };
      },
      compensar: async () => undefined,
    };
    await expect(criarOuRecuperarAtividade(opcoes)).rejects.toThrow(/temporariamente/);
    await expect(criarOuRecuperarAtividade(opcoes)).resolves.toEqual({ atividadeId: 'atividade-1' });
    expect(criacoes).toBe(1);
    expect(confirmacoes).toBe(2);
    expect(JSON.stringify([...storage.dados.values()]).includes(escopo.nome)).toBe(false);
  });

  it('falha de retenção executa remoção compensatória', async () => {
    const storage = new MemoryAtividadeKv({ failSet: true });
    const removidas: string[] = [];
    await expect(
      criarOuRecuperarAtividade({
        storage,
        escopo: { ...escopo, nome: 'outra operação' },
        validar: async () => undefined,
        criar: async () => ({ id: 'atividade-2' }),
        confirmar: async () => {
          throw new Error('não deve confirmar sem retenção');
        },
        compensar: async (id) => {
          removidas.push(id);
        },
      }),
    ).rejects.toThrow(/reter/);
    expect(removidas).toEqual(['atividade-2']);
  });
});
