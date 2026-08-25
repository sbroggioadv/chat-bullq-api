import { idSeguro } from './ids';
import { pareceSensivel } from './comentario';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const HISTORICO_PREFIX = '🔄 histórico da conversa · via inbox';
export const COMMENT_TEXT_MAX = 8_000;

export const INCORPORATE_MESSAGE_TYPES = new Set([
  'TEXT',
  'IMAGE',
  'AUDIO',
  'VIDEO',
  'DOCUMENT',
  'STICKER',
]);

const DENY_MIME = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
]);

const KNOWN_EXT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
};

export type IncorporateKind = 'comment' | 'attachment';

export type IncorporateInput = {
  kind: IncorporateKind;
  messageId?: string;
  documentId?: string;
};

export function validarIncorporacao(dto: {
  kind?: unknown;
  messageId?: unknown;
  documentId?: unknown;
}): { ok: true; value: IncorporateInput } | { ok: false; erro: string } {
  const kind = dto.kind;
  if (kind !== 'comment' && kind !== 'attachment') {
    return { ok: false, erro: 'kind deve ser comment ou attachment' };
  }
  const messageId = typeof dto.messageId === 'string' && dto.messageId.trim() ? dto.messageId.trim() : undefined;
  const documentId =
    typeof dto.documentId === 'string' && dto.documentId.trim() ? dto.documentId.trim() : undefined;
  if (messageId && documentId) {
    return { ok: false, erro: 'informe só messageId ou documentId' };
  }
  if (kind === 'comment') {
    if (documentId) return { ok: false, erro: 'comentário não aceita documentId' };
    if (!messageId || !idSeguro(messageId)) return { ok: false, erro: 'messageId inválido' };
    return { ok: true, value: { kind, messageId } };
  }
  if (messageId) {
    if (!idSeguro(messageId)) return { ok: false, erro: 'messageId inválido' };
    return { ok: true, value: { kind, messageId } };
  }
  if (documentId) {
    if (!idSeguro(documentId)) return { ok: false, erro: 'documentId inválido' };
    return { ok: true, value: { kind, documentId } };
  }
  return { ok: false, erro: 'attachment exige messageId ou documentId' };
}

export function textoDaMensagem(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const raw = content as Record<string, unknown>;
  for (const key of ['text', 'body', 'caption']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) return String(raw[key]);
  }
  return '';
}

export function urlDaMensagem(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const raw = content as Record<string, unknown>;
  for (const key of ['url', 'mediaUrl', 'fileUrl']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) return String(raw[key]).trim();
  }
  return null;
}

export function mimeDaOrigem(content: unknown, fallback?: string | null): string {
  if (fallback && fallback.trim()) return fallback.trim().toLowerCase();
  if (!content || typeof content !== 'object') return '';
  const raw = content as Record<string, unknown>;
  for (const key of ['mimeType', 'mimetype', 'mime']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) return String(raw[key]).trim().toLowerCase();
  }
  return '';
}

export function nomeDaOrigem(content: unknown, fallback?: string | null): string {
  if (fallback && fallback.trim()) return fallback.trim();
  if (!content || typeof content !== 'object') return '';
  const raw = content as Record<string, unknown>;
  for (const key of ['fileName', 'filename', 'name']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) return String(raw[key]).trim();
  }
  return '';
}

export function sanitizarFilename(nome: string): string {
  const base = nome.replace(/\\/g, '/').split('/').pop() ?? '';
  const limpo = base.replace(/[^\w.\- ()áéíóúâêôãõçÁÉÍÓÚÂÊÔÃÕÇ]+/gi, '_').trim();
  const cortado = limpo.slice(0, 180);
  return cortado || 'anexo';
}

export function mimePermitido(mime: string, filename: string): boolean {
  const tipo = (mime || '').trim().toLowerCase();
  if (!tipo) return false;
  if (DENY_MIME.has(tipo)) return false;
  if (tipo.startsWith('image/')) return true;
  if (
    tipo === 'application/pdf'
    || tipo === 'application/msword'
    || tipo === 'text/plain'
    || tipo === 'audio/ogg'
    || tipo === 'audio/mpeg'
    || tipo === 'audio/mp4'
    || tipo === 'video/mp4'
    || tipo.startsWith('application/vnd.openxmlformats-officedocument.')
  ) {
    return true;
  }
  if (tipo === 'application/octet-stream') {
    const ext = extname(filename);
    return Boolean(ext && KNOWN_EXT_MIME[ext]);
  }
  return false;
}

export function mimeDeFilename(filename: string): string | null {
  return KNOWN_EXT_MIME[extname(filename)] ?? null;
}

function extname(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot).toLowerCase();
}

export function montarHistorico(input: {
  quando: Date;
  senderName?: string | null;
  direcao?: string | null;
  texto: string;
}): string {
  const quem = (input.senderName && input.senderName.trim()) || direcaoLabel(input.direcao);
  const texto = input.texto.slice(0, COMMENT_TEXT_MAX);
  return [HISTORICO_PREFIX, '', `[${isoSaoPaulo(input.quando)}] ${quem}: ${texto}`].join('\n');
}

export function historicoSensivel(texto: string): boolean {
  return pareceSensivel(texto);
}

function direcaoLabel(direcao?: string | null): string {
  if (direcao === 'INBOUND') return 'entrada';
  if (direcao === 'OUTBOUND') return 'saída';
  return direcao?.trim() || 'conversa';
}

export function isoSaoPaulo(quando: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(quando);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}:${pick('second')}-03:00`;
}
