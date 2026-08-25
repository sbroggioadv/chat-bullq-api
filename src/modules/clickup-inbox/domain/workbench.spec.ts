import { idsCatalogoAtalhos, idsCatalogoLive, idsCatalogoUniao, listsDoSpace } from './workbench';

describe('catálogo workbench', () => {
  const profile = {
    lists: [{ id: 'list-vendas' }],
    projectLists: [{ id: 'list-holding' }],
  };
  const tree = {
    spaces: [
      {
        id: 'space-comercial',
        label: 'Comercial',
        folders: [],
        lists: [{ id: 'list-consultivo-comercial', label: 'Consultivo' }],
      },
      {
        id: 'space-projetos',
        label: 'Projetos',
        folders: [
          {
            id: 'folder-iniciais',
            label: 'Iniciais',
            lists: [{ id: 'list-iniciais-live', label: 'Iniciais a Confeccionar' }],
          },
        ],
        lists: [{ id: 'list-holding-live', label: 'Holding' }],
      },
    ],
  };

  it('une atalhos com lists da árvore live', () => {
    expect([...idsCatalogoAtalhos(profile)].sort()).toEqual(['list-holding', 'list-vendas']);
    expect([...idsCatalogoLive(tree)].sort()).toEqual([
      'list-consultivo-comercial',
      'list-holding-live',
      'list-iniciais-live',
    ]);
    expect([...idsCatalogoUniao(profile, tree)].sort()).toEqual([
      'list-consultivo-comercial',
      'list-holding',
      'list-holding-live',
      'list-iniciais-live',
      'list-vendas',
    ]);
  });

  it('filtra lists de um space incluindo folders', () => {
    expect(listsDoSpace(tree, 'space-projetos').sort()).toEqual([
      'list-holding-live',
      'list-iniciais-live',
    ]);
    expect(listsDoSpace(tree, 'space-ausente')).toEqual([]);
  });
});
