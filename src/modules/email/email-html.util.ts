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

/** img src: só http(s). cid: fica pro futuro (proxy Gmail). */
function safeImgSrc(raw: string): string | null {
  const v = decodeEntities(raw).trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v) && !/javascript:/i.test(v)) {
    return v.slice(0, 2000);
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
 * Inclui condicionais MSO e style malformado.
 */
export function stripDangerousEmailBlocks(html: string): string {
  return String(html || '')
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, ' ')
    .replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, ' ')
    .replace(
      /<(script|style|iframe|object|embed|form|link|meta|base|textarea|noscript|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      ' ',
    )
    .replace(
      /<(script|style|iframe|object|embed|form|link|meta|base|textarea|noscript|svg|math)\b[^>]*\/?>/gi,
      ' ',
    );
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
      // ignora trechos que ainda parecem CSS puro
      if (looksLikeCssDump(text) && text.length > 40) continue;
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
      ]) {
        const v = attrValue(attrsRaw, name);
        if (v == null) continue;
        if (name === 'bgcolor' && !/^#?[0-9a-zA-Z]{3,20}$/.test(v)) continue;
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
  if (t.length < 20) return false;
  const hits = [
    /#outlook\b/i,
    /\.ExternalClass\b/i,
    /@media\s+only\s+screen/i,
    /mso-/i,
    /\{\s*padding\s*:\s*0/i,
    /\/\*[\s\S]*?\*\//,
    /body\s*\{\s*width\s*:\s*100%\s*!important/i,
    /-ms-text-size-adjust/i,
    /table\s*,\s*td\s*\{/i,
  ].filter((re) => re.test(t)).length;
  return hits >= 1 && (hits >= 2 || /[{};]/.test(t));
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
    if (/<[a-z][\s\S]*>/i.test(single)) acc.html = single;
    else acc.text = single;
  }
  let text = acc.text.trim().slice(0, 20000);
  // plain part às vezes é o dump CSS do client — descarta
  if (looksLikeCssDump(text)) text = '';
  return {
    text,
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
