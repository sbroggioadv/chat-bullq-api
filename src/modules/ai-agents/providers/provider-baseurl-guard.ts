import { BadRequestException } from '@nestjs/common';
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { OPENAI_COMPATIBLE_DEFAULT_BASE_URL } from './provider-defaults';

/**
 * SSRF guard para o `baseUrl` custom de credenciais de provider.
 *
 * O `OpenAiCompatibleAdapter` faz um fetch AUTENTICADO (Bearer) contra o
 * baseUrl da credencial. Sem restrição, um baseUrl tipo
 * `http://169.254.169.254/` (metadata endpoint), `http://localhost:*` ou um
 * IP privado transformaria o servidor num proxy SSRF — agravado no futuro
 * multi-tenant, onde uma org poderia mirar a infra interna.
 *
 * Defesa em profundidade:
 *   1. Allowlist de hosts conhecidos (match EXATO de hostname, case-insensitive)
 *      — derivada dos defaults + hosts oficiais alternativos. Extensível via
 *      env `AI_PROVIDER_ALLOWED_HOSTS` (CSV) pra proxy self-hosted.
 *   2. Sem substring/endsWith — bloqueia `api.moonshot.ai.evil.com` e `xapi.z.ai`.
 *   3. `https` obrigatório.
 *   4. Rejeição de IP literal privado/loopback/link-local/ULA + `localhost`
 *      (defesa extra caso a allowlist seja estendida por env).
 */

/** Hosts derivados dos base URLs default (fonte única, evita drift). */
const DERIVED_DEFAULT_HOSTS: string[] = Object.values(
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
)
  .filter((u): u is string => typeof u === 'string' && u.length > 0)
  .map((u) => new URL(u).hostname.toLowerCase());

/**
 * Allowlist default de hosts de providers conhecidos. Inclui os defaults +
 * endpoints regionais/alternativos oficiais (China, OpenRouter, Gemini
 * OpenAI-compat).
 */
export const DEFAULT_ALLOWED_PROVIDER_HOSTS: ReadonlySet<string> = new Set<string>([
  ...DERIVED_DEFAULT_HOSTS,
  'api.openai.com',
  'api.moonshot.ai',
  'api.moonshot.cn',
  'api.z.ai',
  'open.bigmodel.cn',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
]);

/**
 * Allowlist efetiva = default ∪ `AI_PROVIDER_ALLOWED_HOSTS` (CSV do env).
 * Lida do env a cada chamada (barato) pra permitir override sem restart em
 * runtimes que recarregam env.
 */
export function getAllowedProviderHosts(): Set<string> {
  const hosts = new Set<string>(DEFAULT_ALLOWED_PROVIDER_HOSTS);
  const extra = process.env.AI_PROVIDER_ALLOWED_HOSTS;
  if (extra) {
    for (const raw of extra.split(',')) {
      const h = raw.trim().toLowerCase();
      if (h) hosts.add(h);
    }
  }
  return hosts;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Host é um destino interno perigoso? (loopback / privado / link-local / ULA /
 * unspecified / localhost). Roda mesmo pra hosts allowlisted como segunda
 * barreira.
 */
function isDisallowedInternalHost(hostname: string): boolean {
  const h = stripBrackets(hostname.toLowerCase());
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // IPv4 literal
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const oct = m.slice(1).map((n) => Number(n));
    if (oct.some((n) => n > 255)) return true; // malformado → trata como perigoso
    const [a, b] = oct;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // loopback 127/8
    if (a === 10) return true; // privado 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // privado 172.16/12
    if (a === 192 && b === 168) return true; // privado 192.168/16
    if (a === 169 && b === 254) return true; // link-local 169.254/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }

  // IPv6 literal
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true; // loopback / unspecified
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA fc00::/7
    if (h.startsWith('fe80')) return true; // link-local fe80::/10
    if (h.startsWith('::ffff:')) return true; // IPv4-mapped
    return false;
  }

  return false;
}

export interface BaseUrlValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Valida um baseUrl de provider contra a política SSRF. Puro (sem throw) — usado
 * pelo class-validator do DTO e pelo resolver.
 */
export function validateProviderBaseUrl(raw: string): BaseUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'baseUrl is not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'baseUrl must use https' };
  }
  const host = stripBrackets(url.hostname.toLowerCase());
  if (isDisallowedInternalHost(host)) {
    return {
      ok: false,
      reason: 'baseUrl host points to a private/loopback/link-local address',
    };
  }
  if (!getAllowedProviderHosts().has(host)) {
    return {
      ok: false,
      reason: `baseUrl host "${host}" is not in the provider allowlist`,
    };
  }
  return { ok: true };
}

export function isAllowedProviderBaseUrl(raw: string): boolean {
  return validateProviderBaseUrl(raw).ok;
}

/**
 * Lança `BadRequestException` (400) quando o baseUrl viola a política. Usado no
 * write-path (upsert de credencial).
 */
export function assertAllowedProviderBaseUrl(raw: string): void {
  const res = validateProviderBaseUrl(raw);
  if (!res.ok) {
    throw new BadRequestException({
      code: 'INVALID_PROVIDER_BASE_URL',
      message: res.reason ?? 'baseUrl not allowed',
    });
  }
}

// ─── class-validator constraint (write-path, rejeita no DTO com 400) ────────

@ValidatorConstraint({ name: 'isAllowedProviderBaseUrl', async: false })
export class IsAllowedProviderBaseUrlConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    return typeof value === 'string' && isAllowedProviderBaseUrl(value);
  }

  defaultMessage(): string {
    return 'baseUrl must be an https URL of a known AI provider host (allowlist) and never a private/loopback address';
  }
}

export function IsAllowedProviderBaseUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isAllowedProviderBaseUrl',
      target: object.constructor,
      propertyName,
      options,
      validator: IsAllowedProviderBaseUrlConstraint,
    });
  };
}
