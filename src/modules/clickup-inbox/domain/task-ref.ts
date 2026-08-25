import { idSeguro } from './ids';

const CLICKUP_HOST = /(^|\.)clickup\.com$/i;

export function extrairTaskRef(taskRef: unknown): string | null {
  if (typeof taskRef !== 'string') return null;
  const bruto = taskRef.trim();
  if (!bruto || bruto.length > 500) return null;

  if (/^https:\/\//i.test(bruto)) {
    try {
      const url = new URL(bruto);
      if (url.protocol !== 'https:') return null;
      if (!CLICKUP_HOST.test(url.hostname)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      const t = parts.indexOf('t');
      if (t >= 0) {
        const a = parts[t + 1];
        const b = parts[t + 2];
        if (b && idSeguro(b)) return b;
        if (a && idSeguro(a)) return a;
      }
      const last = parts[parts.length - 1];
      return last && idSeguro(last) ? last : null;
    } catch {
      return null;
    }
  }

  return idSeguro(bruto) ? bruto : null;
}
