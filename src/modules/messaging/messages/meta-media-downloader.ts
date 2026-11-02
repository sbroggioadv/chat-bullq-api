import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as dns from 'dns';
import * as https from 'https';
import * as net from 'net';
import { UploadsService } from './uploads.service';

/**
 * Download de mídia hospedada no CDN da Meta (Instagram), com as travas de
 * SSRF e abuso da SPEC-017:
 *   - só `https`, porta 443, sem credenciais na URL;
 *   - host na lista permitida (nada além) e nunca IP literal;
 *   - resolução DNS que aponta para IP privado/reservado é recusada no
 *     próprio `lookup` do agente (vale para a conexão real, não só a checagem);
 *   - redirecionamento só é seguido se o destino passa nas mesmas regras;
 *   - timeout total de 20 s, teto UploadsService.MAX_INBOUND_BYTES;
 *   - `Content-Type` precisa ser image/, video/ ou audio/.
 *
 * As URLs da Meta são assinadas: nenhum erro daqui carrega a URL. A mensagem
 * do erro é só o código do motivo.
 */

export const META_MEDIA_TIMEOUT_MS = 20_000;
export const META_MEDIA_MAX_REDIRECTS = 3;

const EXACT_HOSTS = new Set(['lookaside.fbsbx.com']);
const HOST_SUFFIXES = ['.fbcdn.net', '.cdninstagram.com'];
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];

export type MediaDownloadFailureReason =
  | 'invalid_url'
  | 'not_https'
  | 'ip_literal'
  | 'host_not_allowed'
  | 'private_address'
  | 'redirect_refused'
  | 'too_many_redirects'
  | 'http_status'
  | 'content_type_not_allowed'
  | 'too_large'
  | 'empty_body'
  | 'timeout'
  | 'network';

export class MediaDownloadError extends Error {
  constructor(
    readonly reason: MediaDownloadFailureReason,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(status ? `${reason}:${status}` : reason);
    this.name = 'MediaDownloadError';
  }
}

export interface MediaHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  data: Buffer;
}

/** Transporte HTTP (fronteira de rede) — injetável para teste. */
export type MediaHttpGet = (
  url: string,
  opts: { timeoutMs: number; maxBytes: number },
) => Promise<MediaHttpResponse>;

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
  host: string;
}

/** Host do link, ou null se a URL nem parseia. Seguro para log (sem query). */
export function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isAllowedHost(hostname: string): boolean {
  if (EXACT_HOSTS.has(hostname)) return true;
  return HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Valida a URL contra as regras. Devolve a URL parseada ou lança
 * MediaDownloadError (não-retentável).
 */
export function assertAllowedMediaUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MediaDownloadError('invalid_url', false);
  }
  if (url.protocol !== 'https:') throw new MediaDownloadError('not_https', false);
  if (url.username || url.password) throw new MediaDownloadError('invalid_url', false);
  if (url.port && url.port !== '443') throw new MediaDownloadError('invalid_url', false);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) throw new MediaDownloadError('ip_literal', false);
  if (!isAllowedHost(hostname)) throw new MediaDownloadError('host_not_allowed', false);
  return url;
}

/** true se a URL é do CDN da Meta e passaria na validação (sem rede). */
export function isMirrorableMetaMediaUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    assertAllowedMediaUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

const BLOCKED_V4 = (() => {
  const list = new net.BlockList();
  const v4: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [addr, prefix] of v4) list.addSubnet(addr, prefix, 'ipv4');
  return list;
})();

/**
 * IPv6 por lista FECHADA: só passa unicast global (2000::/3). Tudo fora dela
 * é recusado sem precisar ser listado — inclusive ::/96 (compatível IPv4,
 * ex.: ::127.0.0.1), ::ffff:0:0/96 (IPv4 mapeado), 64:ff9b::/96 e
 * 64:ff9b:1::/48 (NAT64), fc00::/7, fe80::/10, ::1, :: e multicast.
 */
const GLOBAL_V6 = (() => {
  const list = new net.BlockList();
  list.addSubnet('2000::', 3, 'ipv6');
  return list;
})();

/** Dentro de 2000::/3, faixas que ainda assim não são destino legítimo. */
const BLOCKED_V6_INSIDE_GLOBAL = (() => {
  const list = new net.BlockList();
  const v6: Array<[string, number]> = [
    ['2001::', 23], // atribuições de protocolo da IETF, inclui Teredo 2001::/32
    ['2001:db8::', 32], // documentação
    ['2002::', 16], // 6to4 (embute IPv4 qualquer)
    ['3fff::', 20], // documentação
  ];
  for (const [addr, prefix] of v6) list.addSubnet(addr, prefix, 'ipv6');
  return list;
})();

/**
 * true para todo endereço que não seja destino público legítimo: IPv4
 * privado/loopback/link-local/reservado/multicast e IPv6 fora do unicast
 * global (lista fechada acima). Texto que não é IP também é recusado.
 */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED_V4.check(address, 'ipv4');
  if (family === 6) {
    if (!GLOBAL_V6.check(address, 'ipv6')) return true;
    return BLOCKED_V6_INSIDE_GLOBAL.check(address, 'ipv6');
  }
  return true;
}

class PrivateAddressError extends Error {
  readonly code = 'EPRIVATEADDR';
}

/**
 * `lookup` do agente HTTPS: resolve e recusa se QUALQUER endereço for
 * privado. Como é o lookup usado na conexão, não há janela entre checar e
 * conectar (DNS rebinding).
 */
export function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, undefined);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new PrivateAddressError('private_address'), undefined);
    }
    if (options?.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const safeAgent = new https.Agent({ lookup: safeLookup as any });

/** Transporte padrão: axios sem seguir redirect, sem proxy, com teto. */
export const axiosMediaHttpGet: MediaHttpGet = async (url, opts) => {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    maxRedirects: 0,
    timeout: opts.timeoutMs,
    signal: AbortSignal.timeout(opts.timeoutMs),
    maxContentLength: opts.maxBytes,
    validateStatus: () => true,
    httpsAgent: safeAgent,
    proxy: false,
  });
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    headers[k.toLowerCase()] = v == null ? undefined : String(v);
  }
  return { status: res.status, headers, data: Buffer.from(res.data ?? []) };
};

/** Converte falha de transporte em MediaDownloadError sem vazar a URL. */
function classifyTransportError(err: any): MediaDownloadError {
  const code = String(err?.code ?? err?.cause?.code ?? '');
  const message = String(err?.message ?? '');
  if (code === 'EPRIVATEADDR' || err?.cause?.code === 'EPRIVATEADDR') {
    return new MediaDownloadError('private_address', false);
  }
  if (/maxContentLength/i.test(message)) return new MediaDownloadError('too_large', false);
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ERR_CANCELED' ||
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError'
  ) {
    return new MediaDownloadError('timeout', true);
  }
  return new MediaDownloadError('network', true);
}

@Injectable()
export class MetaMediaDownloader {
  private httpGet: MediaHttpGet = axiosMediaHttpGet;
  private maxBytes = UploadsService.MAX_INBOUND_BYTES;
  private timeoutMs = META_MEDIA_TIMEOUT_MS;

  /** Fábrica para teste: troca só a fronteira de rede e os limites. */
  static withTransport(
    httpGet: MediaHttpGet,
    limits: { maxBytes?: number; timeoutMs?: number } = {},
  ): MetaMediaDownloader {
    const d = new MetaMediaDownloader();
    d.httpGet = httpGet;
    d.maxBytes = limits.maxBytes ?? d.maxBytes;
    d.timeoutMs = limits.timeoutMs ?? d.timeoutMs;
    return d;
  }

  /** Limites efetivos (para conferência em teste). */
  get limits(): { maxBytes: number; timeoutMs: number } {
    return { maxBytes: this.maxBytes, timeoutMs: this.timeoutMs };
  }

  async download(rawUrl: string): Promise<DownloadedMedia> {
    let current = assertAllowedMediaUrl(rawUrl);
    // Prazo único para o download inteiro, somando todos os saltos: cada
    // requisição recebe só o tempo que ainda resta.
    const deadline = Date.now() + this.timeoutMs;

    for (let hop = 0; ; hop++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new MediaDownloadError('timeout', true);
      let res: MediaHttpResponse;
      try {
        res = await this.httpGet(current.toString(), {
          timeoutMs: remainingMs,
          maxBytes: this.maxBytes,
        });
      } catch (err) {
        throw classifyTransportError(err);
      }

      if (res.status >= 300 && res.status < 400) {
        if (hop >= META_MEDIA_MAX_REDIRECTS) {
          throw new MediaDownloadError('too_many_redirects', false, res.status);
        }
        const location = res.headers['location'];
        if (!location) throw new MediaDownloadError('http_status', false, res.status);
        let next: URL;
        try {
          next = assertAllowedMediaUrl(new URL(location, current).toString());
        } catch {
          throw new MediaDownloadError('redirect_refused', false, res.status);
        }
        current = next;
        continue;
      }

      if (res.status !== 200) {
        const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
        throw new MediaDownloadError('http_status', retryable, res.status);
      }

      const mimeType = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
        throw new MediaDownloadError('content_type_not_allowed', false);
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > this.maxBytes) {
        throw new MediaDownloadError('too_large', false);
      }
      if (res.data.byteLength > this.maxBytes) {
        throw new MediaDownloadError('too_large', false);
      }
      if (res.data.byteLength === 0) throw new MediaDownloadError('empty_body', true);

      return { buffer: res.data, mimeType, host: current.hostname };
    }
  }
}
