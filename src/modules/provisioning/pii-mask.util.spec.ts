import { maskEmail, maskPhone } from './pii-mask.util';

describe('maskEmail', () => {
  it('mantém só o 1º char do local + domínio', () => {
    expect(maskEmail('admin@example.com')).toBe('a***@example.com');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
  });

  it('não vaza o local part completo', () => {
    const masked = maskEmail('joaosilva@dominio.com.br');
    expect(masked).toBe('j***@dominio.com.br');
    expect(masked).not.toContain('joaosilva');
  });

  it('degrada com segurança em entrada inválida', () => {
    expect(maskEmail('semarroba')).toBe('***');
    expect(maskEmail('@dominio.com')).toBe('***');
  });
});

describe('maskPhone', () => {
  it('mantém só os últimos 4 dígitos', () => {
    expect(maskPhone('5511999998888')).toBe('****8888');
  });

  it('ignora formatação e não vaza o número completo', () => {
    const masked = maskPhone('+55 (11) 99999-8888');
    expect(masked).toBe('****8888');
    expect(masked).not.toContain('99999');
  });

  it('degrada com segurança em número muito curto', () => {
    expect(maskPhone('12')).toBe('****');
  });
});
