import { parseArgs } from '../../../scripts/provision-tenant';

/**
 * Regressão do finding CodeRabbit #3: `--flag=valor` booleano.
 * ANTES: `--dry-run=true` caía no ramo de valores e o dry-run NUNCA era
 * aplicado → o script ESCREVIA no banco de verdade. Estes testes travam o
 * contrato do parser.
 */
describe('parseArgs — booleanos com =valor (finding #3)', () => {
  it('--dry-run=true LIGA a flag (não executa contra o banco)', () => {
    const { flags } = parseArgs(['--dry-run=true']);
    expect(flags.has('dry-run')).toBe(true);
  });

  it('--dry-run=false DESLIGA a flag (opt-out explícito)', () => {
    const { flags } = parseArgs(['--dry-run=false']);
    expect(flags.has('dry-run')).toBe(false);
  });

  it('--dry-run (sem valor) LIGA a flag', () => {
    const { flags } = parseArgs(['--dry-run']);
    expect(flags.has('dry-run')).toBe(true);
  });

  it('--dry-run=1 e =yes LIGAM; =0 e =no DESLIGAM', () => {
    expect(parseArgs(['--dry-run=1']).flags.has('dry-run')).toBe(true);
    expect(parseArgs(['--dry-run=yes']).flags.has('dry-run')).toBe(true);
    expect(parseArgs(['--dry-run=0']).flags.has('dry-run')).toBe(false);
    expect(parseArgs(['--dry-run=no']).flags.has('dry-run')).toBe(false);
  });

  it('--keep-pipeline-scope=false não liga a flag', () => {
    const { flags } = parseArgs(['--keep-pipeline-scope=false']);
    expect(flags.has('keep-pipeline-scope')).toBe(false);
  });
});

describe('parseArgs — valores', () => {
  it('aceita --key=value e --key value', () => {
    expect(parseArgs(['--name=Acme']).values.get('name')).toBe('Acme');
    expect(parseArgs(['--name', 'Acme']).values.get('name')).toBe('Acme');
  });

  it('não consome o próximo token se ele for outra flag', () => {
    const { values } = parseArgs(['--name', '--email', 'a@b.co']);
    expect(values.get('name')).toBeUndefined();
    expect(values.get('email')).toBe('a@b.co');
  });

  it('valores com = embutido preservam tudo após o primeiro =', () => {
    const { values } = parseArgs(['--name=Acme=Corp']);
    expect(values.get('name')).toBe('Acme=Corp');
  });
});
