/**
 * HTML de e-mail — sanitize allowlist (sem dependência externa).
 *
 * Dois modos:
 * - compose: formatação simples (editor outbound)
 * - display: e-mail marketing (tabelas, img https, attrs de layout)
 */

const COMPOSE_TAGS = new Set([
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

/** Tags comuns em HTML de newsletter / clients. */
const DISPLAY_TAGS = new Set([
  ...COMPOSE_TAGS,
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'img',
  'center',
  'font',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'figure',
  'figcaption',
  'sup',
  'sub',
  'small',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img']);

const MAX_HTML_CHARS = 200_000;

export type SanitizeMode = 'compose' | 'display';

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
  if (/^(https?:|mailto:)/i.test(v)) {
    if (/javascript:/i.test(v) || /data:/i.test(v)) return null;
    return v.slice(0, 2000);
  }
  if (v.startsWith('#') && !v.includes(':')) return v.slice(0, 200);
  return null;
}

/** img src: http(s) ou data:image/* (cid reescrito no server). */
function safeImgSrc(raw: string): string | null {
  const v = decodeEntities(raw).trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v) && !/javascript:/i.test(v)) {
    return v.slice(0, 2000);
  }
  // data URL de imagem gerada no server a partir de cid:
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);base64,/i.test(v)) {
    // evita data URL gigante / polyglot
    if (v.length > 2_500_000) return null;
    return v;
  }
  return null;
}

/** Filtra CSS inline perigoso; mantém layout de e-mail. */
function safeStyle(raw: string): string | null {
  let s = decodeEntities(raw).slice(0, 4000);
  if (!s.trim()) return null;
  // bloqueia vetores clássicos
  if (
    /expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|url\s*\(\s*['"]?\s*data:/i.test(
      s,
    )
  ) {
    return null;
  }
  // remove url() não-http
  s = s.replace(/url\s*\(\s*(['"]?)(?!https?:)[^)]*\1\s*\)/gi, 'url(about:blank)');
  return s;
}

function attrValue(
  attrsRaw: string,
  name: string,
): string | null {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const m = attrsRaw.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * Remove blocos que nunca devem vazar pro texto/HTML final.
 * Inclui <head>, condicionais MSO e <style> (várias passagens).
 *
 * Importante: se o strip de <style> falhar, o walker de tags
 * deixa o CSS como nó de texto — por isso o strip é agressivo.
 */
export function stripDangerousEmailBlocks(html: string): string {
  let s = String(html || '');

  // head inteiro (quase sempre só style/meta)
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ');

  // condicionais MSO / comentários / CDATA
  s = s.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, ' ');
  s = s.replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, ' ');

  // style/script com nome explícito (não depende de backref de case)
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
    if (s === before) break;
  }
  // style/script não fechado até o próximo bloco estrutural
  s = s.replace(/<style\b[^>]*>[\s\S]*?(?=<(?:body|table|div|center|p)\b|\/body)/gi, ' ');
  s = s.replace(/<script\b[^>]*>[\s\S]*?(?=<(?:body|table|div)\b|\/body)/gi, ' ');

  s = s.replace(
    /<(iframe|object|embed|form|link|meta|base|textarea|noscript|svg|math|title|xml)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  s = s.replace(
    /<(iframe|object|embed|form|link|meta|base|textarea|noscript|svg|math|title|xml|style|script)\b[^>]*\/?>/gi,
    ' ',
  );

  // CSS “nu” que já vazou como texto (comum após strip incompleto)
  s = s.replace(
    /(?:^|[\s>])(?:#outlook|\.ExternalClass|@media\s+only|@font-face|body\s*\{|table\s*,\s*td\s*\{|img\s*\{|a\s+img\s*\{|u\s*\+\s*a\s*\{)[\s\S]{0,8000}?\}(?=\s*(?:<|$))/gi,
    ' ',
  );

  return s;
}

/**
 * Converte HTML (possivelmente sujo) em subset seguro allowlist.
 */
export function sanitizeEmailHtml(
  input: string | null | undefined,
  mode: SanitizeMode = 'compose',
): string {
  const src = String(input || '').slice(0, MAX_HTML_CHARS);
  if (!src.trim()) return '';

  const allowed = mode === 'display' ? DISPLAY_TAGS : COMPOSE_TAGS;
  let html = stripDangerousEmailBlocks(src);

  const out: string[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)\/?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  const openStack: string[] = [];

  while ((m = re.exec(html)) !== null) {
    if (m[3] != null) {
      const text = m[3];
      // ignora trechos que ainda parecem CSS puro (threshold baixo — print do Doc)
      if (looksLikeCssDump(text) || isMostlyCssNoise(text)) continue;
      out.push(escapeText(text));
      continue;
    }

    const tag = m[1].toLowerCase();
    const isClose = m[0].startsWith('</');
    const selfClosing = /\/>$/.test(m[0].trim()) || VOID_TAGS.has(tag);
    const attrsRaw = m[2] || '';

    if (!allowed.has(tag)) continue;

    if (isClose) {
      const idx = openStack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (openStack.length > idx) {
        const t = openStack.pop()!;
        if (!VOID_TAGS.has(t)) out.push(`</${t}>`);
      }
      continue;
    }

    if (tag === 'br') {
      out.push('<br />');
      continue;
    }
    if (tag === 'hr') {
      out.push('<hr />');
      continue;
    }

    if (tag === 'img') {
      if (mode !== 'display') continue;
      const srcAttr = attrValue(attrsRaw, 'src');
      const safeSrc = srcAttr ? safeImgSrc(srcAttr) : null;
      if (!safeSrc) continue;
      const alt = attrValue(attrsRaw, 'alt') || '';
      const width = attrValue(attrsRaw, 'width');
      const height = attrValue(attrsRaw, 'height');
      let img = `<img src="${escapeText(safeSrc)}" alt="${escapeText(alt.slice(0, 200))}"`;
      if (width && /^\d{1,4}%?$/.test(width)) img += ` width="${width}"`;
      if (height && /^\d{1,4}%?$/.test(height)) img += ` height="${height}"`;
      const st = attrValue(attrsRaw, 'style');
      const safeSt = st ? safeStyle(st) : null;
      if (safeSt) img += ` style="${escapeText(safeSt)}"`;
      img += ' />';
      out.push(img);
      continue;
    }

    if (tag === 'a') {
      const hrefRaw = attrValue(attrsRaw, 'href');
      const href = hrefRaw ? safeHref(hrefRaw) : null;
      if (!href) continue;
      out.push(
        `<a href="${escapeText(href)}" rel="noopener noreferrer" target="_blank">`,
      );
      openStack.push('a');
      continue;
    }

    // tags de layout com attrs limitados
    const attrs: string[] = [];
    if (mode === 'display') {
      for (const name of [
        'width',
        'height',
        'align',
        'valign',
        'bgcolor',
        'border',
        'cellpadding',
        'cellspacing',
        'colspan',
        'rowspan',
        'role',
        'color',
        'face',
        'size',
      ]) {
        const v = attrValue(attrsRaw, name);
        if (v == null) continue;
        if (name === 'bgcolor' && !/^#?[0-9a-zA-Z]{3,20}$/.test(v)) continue;
        if (name === 'color' && !/^#?[0-9a-zA-Z]{3,30}$/.test(v)) continue;
        if (name === 'face' && !/^[a-zA-Z0-9 ,\-_]{1,80}$/.test(v)) continue;
        if (name === 'size' && !/^[1-7]$/.test(v)) continue;
        if (
          ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan'].includes(
            name,
          ) &&
          !/^\d{1,4}%?$/.test(v)
        ) {
          continue;
        }
        if (['align', 'valign', 'role'].includes(name) && !/^[a-zA-Z0-9_\-]{1,20}$/.test(v)) {
          continue;
        }
        attrs.push(`${name}="${escapeText(v)}"`);
      }
      const st = attrValue(attrsRaw, 'style');
      const safeSt = st ? safeStyle(st) : null;
      if (safeSt) attrs.push(`style="${escapeText(safeSt)}"`);
    }

    if (selfClosing && VOID_TAGS.has(tag)) {
      out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''} />`);
      continue;
    }

    out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
    openStack.push(tag);
  }

  while (openStack.length) {
    const t = openStack.pop()!;
    if (!VOID_TAGS.has(t)) out.push(`</${t}>`);
  }

  return out.join('').trim();
}

/** Detecta dump de CSS de client de e-mail no plain text. */
export function looksLikeCssDump(s: string): boolean {
  const t = String(s || '');
  if (t.length < 12) return false;
  const hits = [
    /#outlook\b/i,
    /\.ExternalClass\b/i,
    /@media\s+only/i,
    /@font-face\b/i,
    /mso-/i,
    /\{\s*padding\s*:\s*0/i,
    /\/\*[\s\S]*?\*\//,
    /body\s*\{\s*width\s*:\s*100%\s*!important/i,
    /-ms-text-size-adjust/i,
    /-webkit-text-size-adjust/i,
    /table\s*,\s*td\s*\{/i,
    /u\s*\+\s*a\s*\{/i,
    /a\s+img\s*\{/i,
    /#MessageViewBody/i,
    /\.yshortcuts/i,
  ].filter((re) => re.test(t)).length;
  return hits >= 1 && (hits >= 2 || /[{};]/.test(t));
}

/** Heurística: texto com densidade alta de tokens CSS e pouco prosa. */
export function isMostlyCssNoise(s: string): boolean {
  const t = String(s || '').trim();
  if (t.length < 24) return false;
  if (looksLikeCssDump(t)) return true;
  const braces = (t.match(/[{}]/g) || []).length;
  const semis = (t.match(/;/g) || []).length;
  const words = (t.match(/[A-Za-zÀ-ÿ]{3,}/g) || []).length;
  const cssProp =
    (t.match(
      /(?:padding|margin|border|background|font-size|line-height|text-decoration|display|width|height|max-width)\s*:/gi,
    ) || []).length;
  if (cssProp >= 2 && braces >= 2) return true;
  if (braces >= 4 && semis >= 4 && words < braces * 3) return true;
  // bloco tipo "u + a{background: ...}"
  if (/^[\s\S]{0,40}[\w.\#+\s]+\{[^}]{8,}\}/.test(t) && semis >= 1) {
    return cssProp >= 1 || /background|padding|margin|border/i.test(t);
  }
  return false;
}

/** HTML → texto puro legível (fallback plain part / body). */
export function htmlToPlainText(html: string): string {
  const cleaned = stripDangerousEmailBlocks(html);
  const text = decodeEntities(
    cleaned
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi, ' $1 ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
  if (looksLikeCssDump(text)) {
    // tenta tirar linhas com cara de CSS
    return text
      .split('\n')
      .filter((line) => !looksLikeCssDump(line) && !/^\s*[{}.;@#]/.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return text;
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

export interface GmailPartRef {
  mimeType: string;
  /** base64url inline (pode estar vazio se só attachmentId) */
  data?: string;
  attachmentId?: string;
  size?: number;
  filename?: string;
  contentId?: string;
  /** Gmail costuma espelhar o cid em X-Attachment-Id */
  xAttachmentId?: string;
  inline?: boolean;
  headers?: Array<{ name: string; value: string }>;
}

function headerVal(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  return (
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ||
    ''
  );
}

/** Walk recursivo do payload Gmail. */
export function walkGmailParts(root: any): GmailPartRef[] {
  const out: GmailPartRef[] = [];
  const walk = (part: any) => {
    if (!part) return;
    const headers: Array<{ name: string; value: string }> = part.headers || [];
    const contentIdRaw = headerVal(headers, 'Content-ID');
    const contentId = contentIdRaw.replace(/[<>]/g, '').trim() || undefined;
    const xAttachmentId =
      headerVal(headers, 'X-Attachment-Id').trim() || undefined;
    const disposition = headerVal(headers, 'Content-Disposition');
    const inline =
      !!contentId ||
      !!xAttachmentId ||
      /\binline\b/i.test(disposition);
    const mimeType = String(part.mimeType || '');
    const filename = String(part.filename || '').trim() || undefined;
    const data = part.body?.data ? String(part.body.data) : undefined;
    const attachmentId = part.body?.attachmentId
      ? String(part.body.attachmentId)
      : undefined;
    const size = Number(part.body?.size || 0) || undefined;
    if (data || attachmentId || filename || contentId || xAttachmentId) {
      out.push({
        mimeType,
        data,
        attachmentId,
        size,
        filename,
        contentId,
        xAttachmentId,
        inline,
        headers,
      });
    }
    for (const child of part.parts || []) walk(child);
  };
  walk(root);
  return out;
}

/** Extrai text + html crus de um payload Gmail (sem sanitize). Só dados inline. */
export function extractBodyParts(msg: any): { text: string; html: string } {
  const parts = walkGmailParts(msg?.payload);
  let text = '';
  let html = '';
  for (const p of parts) {
    const mime = p.mimeType.toLowerCase();
    if (!p.data) continue;
    if (mime === 'text/plain' || mime.startsWith('text/plain;')) {
      text += decodeBodyData(p.data);
    } else if (mime === 'text/html' || mime.startsWith('text/html;')) {
      html += decodeBodyData(p.data);
    }
  }
  if (!text && !html && msg?.payload?.body?.data) {
    const single = decodeBodyData(msg.payload.body.data);
    if (/<[a-z][\s\S]*>/i.test(single)) html = single;
    else text = single;
  }
  text = text.trim().slice(0, 20000);
  if (looksLikeCssDump(text)) text = '';
  return {
    text,
    html: html.trim().slice(0, MAX_HTML_CHARS),
  };
}

/**
 * Reescreve src="cid:…" no HTML usando mapa contentId → data URL.
 * Aceita cid com/sem <>, case-insensitive.
 */
export function rewriteCidImages(
  html: string,
  cidToDataUrl: Map<string, string>,
): string {
  if (!html || !cidToDataUrl.size) return html;
  const lookup = new Map<string, string>();
  for (const [k, v] of cidToDataUrl) {
    lookup.set(k.toLowerCase(), v);
    lookup.set(k.toLowerCase().replace(/[<>]/g, ''), v);
  }
  return html.replace(
    /(\bsrc\s*=\s*)(["']?)cid:([^"'\s>]+)\2/gi,
    (full, prefix: string, quote: string, cidRaw: string) => {
      const key = decodeEntities(cidRaw).replace(/[<>]/g, '').toLowerCase();
      const dataUrl = lookup.get(key);
      if (!dataUrl) return full;
      const q = quote || '"';
      return `${prefix}${q}${dataUrl}${q}`;
    },
  );
}

export function decodeBodyData(data?: string): string {
  if (!data) return '';
  try {
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

export function decodeBodyBuffer(data?: string): Buffer | null {
  if (!data) return null;
  try {
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/** mime image/* → data URL. */
export function bufferToImageDataUrl(mime: string, buf: Buffer): string | null {
  const m = (mime || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!m.startsWith('image/')) return null;
  if (buf.length > 1_800_000) return null;
  const b64 = buf.toString('base64');
  return `data:${m};base64,${b64}`;
}
