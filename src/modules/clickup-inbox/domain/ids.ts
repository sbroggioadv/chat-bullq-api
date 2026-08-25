export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function idSeguro(valor: unknown): valor is string {
  return typeof valor === 'string' && SAFE_ID.test(valor);
}
