import {
  READONLY_FIELD_TYPES,
  WRITABLE_FIELD_TYPES,
  isWritableType,
  serializeFieldValue,
} from './campos';

const OPCOES = [
  { id: 'opt-1', rotulo: 'Um', cor: null },
  { id: 'l1', rotulo: 'L1', cor: null },
  { id: 'l2', rotulo: 'L2', cor: null },
];

describe('matriz de campos W1 (AC-05)', () => {
  it.each([
    ['drop_down', 'opt-1', 'opt-1'],
    ['drop_down', '', null],
    ['labels', ['l1', 'l2'], ['l1', 'l2']],
    ['date', '2026-08-25', String(new Date('2026-08-25T12:00:00-03:00').getTime())],
    ['currency', ' 10.5 ', '10.5'],
    ['currency', '', null],
    ['email', ' a@b.test ', 'a@b.test'],
    ['phone', '1199999', '1199999'],
    ['url', 'https://example.test', 'https://example.test'],
    ['short_text', ' oi ', 'oi'],
    ['text', ' bloco ', 'bloco'],
  ] as const)('%s serializa %j', (tipo, input, expected) => {
    expect(serializeFieldValue(tipo, input, OPCOES)).toEqual({ ok: true, value: expected });
  });

  it('recusa option id forjado em drop_down e labels', () => {
    expect(serializeFieldValue('drop_down', 'opt-forjado', OPCOES).ok).toBe(false);
    expect(serializeFieldValue('labels', ['l1', 'nope'], OPCOES).ok).toBe(false);
  });

  it.each([...READONLY_FIELD_TYPES, 'mystery_type'])(
    '%s não é gravável',
    (tipo) => {
      expect(isWritableType(tipo)).toBe(false);
      expect(serializeFieldValue(tipo, 'x').ok).toBe(false);
    },
  );

  it('todos os tipos da matriz W1 são graváveis', () => {
    for (const tipo of WRITABLE_FIELD_TYPES) {
      expect(isWritableType(tipo)).toBe(true);
    }
  });
});
