import { canonico, RECUSA } from './telefone';

describe('telefone canônico (AC-02)', () => {
  it('normaliza brasileiro com e sem nono dígito', () => {
    const comNono = canonico('+55 11 99876-5432');
    expect(comNono.ok).toBe(true);
    if (comNono.ok) expect(comNono.canonico).toBe('551198765432');
    expect(canonico('11 9876-5432')).toEqual(
      expect.objectContaining({ ok: true, canonico: '551198765432' }),
    );
  });

  it('recusa DDI estrangeiro explícito e grupo', () => {
    expect(canonico('+1 415 555 0000')).toEqual(
      expect.objectContaining({ ok: false, motivo: RECUSA.NAO_BR }),
    );
    expect(canonico('123456789@g.us')).toEqual(
      expect.objectContaining({ ok: false, motivo: RECUSA.GRUPO }),
    );
  });
});
