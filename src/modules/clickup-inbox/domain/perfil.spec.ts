import { validarPerfil } from './perfil';

describe('perfil fechado (F-02)', () => {
  const base = {
    lists: [{ id: 'list-leads', label: 'Leads', primary: true }],
    whatsappFieldId: 'field-wa',
    blockedFieldIds: [],
    tag: null,
    activities: null,
  };

  it('aceita um perfil válido', () => {
    expect(validarPerfil(base).ok).toBe(true);
  });

  it('recusa coerção de label/primary e listas duplicadas', () => {
    expect(
      validarPerfil({
        ...base,
        lists: [
          { id: 'list-one', label: { bad: true }, primary: 'false' },
          { id: 'list-one', label: 'dup', primary: '' },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validarPerfil({
        ...base,
        lists: [
          { id: 'list-one', label: 'A', primary: true },
          { id: 'list-one', label: 'dup', primary: false },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validarPerfil({
        ...base,
        lists: [{ id: 'list-leads', label: 'Leads', primary: 'true' }],
      }).ok,
    ).toBe(false);
  });
});
