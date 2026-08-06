/**
 * HTML de e-mail — sanitize allowlist (sem dependência externa).
 * Guidance: só tags de formatação comuns em compose; nada de script/iframe/on*.
 */

const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'u',
  'ul',
]);

const VOID_TAGS = new Set(['br', 'hr']);

const MAX_HTML_CHARS = 100_000;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : '';
    });
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(raw: string): string | null {
  const v = decodeEntities(raw).trim();
  if (!v) return null;
  // só http(s) e mailto
  if (/^(https?:|mailto:)/i.test(v)) {
    // bloqueia javascript: embutido após whitespace tricks
    if (/javascript:/i.test(v)) return null;
    return v.slice(0, 2000);
  }
  if (v.startsWith('#') && !v.includes(':')) return v.slice(0, 200);
  return null;
}

/**
 * Converte HTML (possivelmente sujo) em subset seguro allowlist.
 * Tags desconhecidas viram só o texto interno.
 */
export function sanitizeEmailHtml(input: string | null | undefined): string {
  const src = String(input || '').slice(0, MAX_HTML_CHARS);
  if (!src.trim()) return '';

  // remove comentários, CDATA e blocos perigosos inteiros (tag + conteúdo)
  let html = src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '')
    .replace(
      /<(script|style|iframe|object|embed|form|link|meta|base|textarea|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      '',
    )
    .replace(
      /<(script|style|iframe|object|embed|form|link|meta|base|textarea|noscript)\b[^>]*\/?>/gi,
      '',
    );

  const out: string[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  const openStack: string[] = [];

  while ((m = re.exec(html)) !== null) {
    if (m[3] != null) {
      out.push(escapeText(m[3]));
      continue;
    }
    const tag = m[1].toLowerCase();
    const isClose = m[0].startsWith('</');
    const attrsRaw = m[2] || '';

    if (!ALLOWED_TAGS.has(tag)) {
      // drop tag, keep scanning children
      continue;
    }

    if (isClose) {
      // fecha até achar o tag (HTML tolerante)
      const idx = openStack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (openStack.length > idx) {
        const t = openStack.pop()!;
        if (!VOID_TAGS.has(t)) out.push(`</${t}>`);
      }
      continue;
    }

    if (VOID_TAGS.has(tag)) {
      out.push(tag === 'br' ? '<br />' : '<hr />');
      continue;
    }

    if (tag === 'a') {
      const hrefMatch =
        attrsRaw.match(/\bhref\s*=\s*"([^"]*)"/i) ||
        attrsRaw.match(/\bhref\s*=\s*'([^']*)'/i) ||
        attrsRaw.match(/\bhref\s*=\s*([^\s>]+)/i);
      const href = hrefMatch ? safeHref(hrefMatch[1]) : null;
      if (!href) {
        // âncora sem href seguro: só texto interno
        continue;
      }
      out.push(
        `<a href="${escapeText(href)}" rel="noopener noreferrer" target="_blank">`,
      );
      openStack.push('a');
      continue;
    }

    out.push(`<${tag}>`);
    openStack.push(tag);
  }

  while (openStack.length) {
    const t = openStack.pop()!;
    if (!VOID_TAGS.has(t)) out.push(`</${t}>`);
  }

  return out.join('').trim();
}

/** HTML → texto puro legível (fallback plain part / body). */
export function htmlToPlainText(html: string): string {
  return decodeEntities(
    String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
}

/** Texto puro → HTML mínimo (parágrafos + br). */
export function plainTextToHtml(text: string): string {
  const t = String(text || '').replace(/\r\n/g, '\n');
  if (!t.trim()) return '';
  return t
    .split(/\n{2,}/)
    .map((para) => {
      const inner = escapeText(para).replace(/\n/g, '<br />');
      return `<p>${inner}</p>`;
    })
    .join('');
}

/** Extrai text + html crus de um payload Gmail (sem sanitize). */
export function extractBodyParts(msg: any): { text: string; html: string } {
  const acc = { text: '', html: '' };
  const walk = (part: any) => {
    if (!part) return;
    const mime = String(part.mimeType || '');
    if (mime === 'text/plain' && part.body?.data) {
      acc.text += decodeBodyData(part.body.data);
    } else if (mime === 'text/html' && part.body?.data) {
      acc.html += decodeBodyData(part.body.data);
    }
    for (const child of part.parts || []) walk(child);
  };
  walk(msg?.payload);
  if (!acc.text && !acc.html && msg?.payload?.body?.data) {
    const single = decodeBodyData(msg.payload.body.data);
    // heurística: parece HTML?
    if (/<[a-z][\s\S]*>/i.test(single)) acc.html = single;
    else acc.text = single;
  }
  return {
    text: acc.text.trim().slice(0, 20000),
    html: acc.html.trim().slice(0, MAX_HTML_CHARS),
  };
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
