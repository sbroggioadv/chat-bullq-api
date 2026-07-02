/**
 * Mascaramento de PII para logs (LGPD). Nunca logar e-mail/telefone crus:
 * estes helpers reduzem o dado ao mínimo identificável.
 */

/** Mascara e-mail: mantém só o 1º char do local + domínio. Ex.: a***@dominio.com */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain}`;
}

/** Mascara telefone: mantém só os últimos 4 dígitos. Ex.: ****1808 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `****${digits.slice(-4)}`;
}
