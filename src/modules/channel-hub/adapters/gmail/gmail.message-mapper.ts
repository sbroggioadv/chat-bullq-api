import { MessageDirection } from '@prisma/client';
import {
  MessageContentType,
  NormalizedHistoricalMessage,
  NormalizedMessageContent,
} from '../../ports/types';

export function headerOf(msg: any, name: string): string {
  const headers: Array<{ name: string; value: string }> = msg?.payload?.headers || [];
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function decodeBodyData(data?: string): string {
  if (!data) return '';
  try {
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function walkParts(part: any, acc: { text: string; html: string }) {
  if (!part) return;
  const mime = String(part.mimeType || '');
  if (mime === 'text/plain' && part.body?.data) {
    acc.text += decodeBodyData(part.body.data);
  } else if (mime === 'text/html' && part.body?.data) {
    acc.html += decodeBodyData(part.body.data);
  }
  for (const child of part.parts || []) walkParts(child, acc);
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function extractAddress(raw: string): { email: string; name?: string } {
  // "Name <email@x.com>" | email@x.com
  const m = raw.match(/^(?:"?([^"<]*)"?\s*)?<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?$/i);
  if (m) {
    const name = (m[1] || '').trim();
    return { email: m[2].toLowerCase(), name: name || undefined };
  }
  const only = raw.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (only) return { email: only[1].toLowerCase() };
  return { email: raw.trim().toLowerCase() };
}

/** Extrai todos os e-mails de um header To/Cc (lista separada por vírgula). */
export function extractAddresses(raw: string): Array<{ email: string; name?: string }> {
  if (!raw?.trim()) return [];
  // Split por vírgula fora de aspas/ângulo
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let inQuotes = false;
  for (const ch of raw) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes) {
      if (ch === '<') depth += 1;
      if (ch === '>') depth = Math.max(0, depth - 1);
    }
    if (ch === ',' && !inQuotes && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const out: Array<{ email: string; name?: string }> = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const a = extractAddress(p);
    if (!a.email || !a.email.includes('@') || seen.has(a.email)) continue;
    seen.add(a.email);
    out.push(a);
  }
  return out;
}

export function extractBody(msg: any): string {
  const acc = { text: '', html: '' };
  walkParts(msg?.payload, acc);
  if (acc.text.trim()) return acc.text.trim().slice(0, 20000);
  if (acc.html.trim()) return htmlToText(acc.html).slice(0, 20000);
  // single-part body
  if (msg?.payload?.body?.data) {
    return decodeBodyData(msg.payload.body.data).trim().slice(0, 20000);
  }
  return '';
}

export function normalizeGmailMessage(
  raw: any,
  threadId: string,
  myEmail: string,
): NormalizedHistoricalMessage | null {
  if (!raw?.id) return null;
  const fromRaw = headerOf(raw, 'From');
  const toRaw = headerOf(raw, 'To');
  const subject = headerOf(raw, 'Subject') || '(sem assunto)';
  const dateHdr = headerOf(raw, 'Date');
  const from = extractAddress(fromRaw);
  const my = myEmail.toLowerCase();
  const isOutbound = from.email === my;
  const direction = isOutbound ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;

  let ts = new Date();
  if (raw.internalDate) {
    ts = new Date(Number(raw.internalDate));
  } else if (dateHdr) {
    const d = new Date(dateHdr);
    if (!Number.isNaN(d.getTime())) ts = d;
  }

  const body = extractBody(raw);
  const text = body
    ? `📧 ${subject}\n\n${body}`
    : `📧 ${subject}`;

  const content: NormalizedMessageContent = { text };

  // contact for this message (other party)
  let externalContactId = from.email;
  if (isOutbound) {
    // first To recipient
    const firstTo = (toRaw || '').split(',')[0] || '';
    externalContactId = extractAddress(firstTo).email || 'unknown';
  }

  return {
    externalMessageId: String(raw.id),
    externalConversationId: threadId,
    externalContactId,
    direction,
    timestamp: ts,
    type: MessageContentType.TEXT,
    content,
    senderName: from.name || from.email,
    rawPayload: {
      gmailId: raw.id,
      threadId,
      labelIds: raw.labelIds,
      snippet: raw.snippet,
      subject,
      from: fromRaw,
      to: toRaw,
    },
  };
}

export function pickThreadContact(
  messages: NormalizedHistoricalMessage[],
  myEmail: string,
): { externalContactId: string; contactName?: string } {
  const my = myEmail.toLowerCase();
  // prefer first inbound sender
  for (const m of messages) {
    if (m.direction === MessageDirection.INBOUND && m.externalContactId && m.externalContactId !== my) {
      return {
        externalContactId: m.externalContactId,
        contactName: m.senderName || m.externalContactId,
      };
    }
  }
  // else first outbound recipient
  for (const m of messages) {
    if (m.direction === MessageDirection.OUTBOUND && m.externalContactId && m.externalContactId !== my) {
      return {
        externalContactId: m.externalContactId,
        contactName: m.externalContactId,
      };
    }
  }
  return { externalContactId: 'unknown@gmail.local', contactName: 'Desconhecido' };
}
