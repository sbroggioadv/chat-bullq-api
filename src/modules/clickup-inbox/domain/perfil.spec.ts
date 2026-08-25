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
    expect(validarPerfil(base)).toEqual(
      expect.objectContaining({
        ok: true,
        profile: expect.objectContaining({ projectLists: [] }),
      }),
    );
  });

  it('aceita projectLists opcional com id+label e recusa extras/duplicatas', () => {
    const ok = validarPerfil({
      ...base,
      projectLists: [
        { id: 'list-holding', label: 'Holding' },
        { id: 'list-contencioso', label: 'Contencioso' },
      ],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.profile.projectLists.map((l) => l.id)).toEqual(['list-holding', 'list-contencioso']);
    }
    expect(
      validarPerfil({
        ...base,
        projectLists: [{ id: 'list-holding', label: 'Holding', primary: true }],
      }).ok,
    ).toBe(false);
    expect(
      validarPerfil({
        ...base,
        projectLists: [
          { id: 'list-holding', label: 'A' },
          { id: 'list-holding', label: 'B' },
        ],
      }).ok,
    ).toBe(false);
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
