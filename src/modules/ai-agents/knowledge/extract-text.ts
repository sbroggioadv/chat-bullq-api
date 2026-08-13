import { BadRequestException } from '@nestjs/common';

const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/x-markdown',
  'application/json',
]);

export function inferMime(fileName: string, mime?: string): string {
  const raw = (mime || '').split(';')[0].trim().toLowerCase();
  if (raw && raw !== 'application/octet-stream') return raw;
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  if (ext === '.md') return 'text/markdown';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.json') return 'application/json';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return raw || 'application/octet-stream';
}

export function isSupportedKnowledgeMime(mime: string, fileName: string): boolean {
  const resolved = inferMime(fileName, mime);
  return (
    TEXT_MIMES.has(resolved) ||
    resolved === 'application/pdf' ||
    resolved ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

export async function extractKnowledgeText(
  buffer: Buffer,
  fileName: string,
  mimeType?: string,
): Promise<string> {
  const mime = inferMime(fileName, mimeType);
  if (TEXT_MIMES.has(mime)) {
    return buffer.toString('utf8');
  }
  if (mime === 'application/pdf') {
    return extractPdf(buffer);
  }
  if (
    mime ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return extractDocx(buffer);
  }
  throw new BadRequestException(
    `Formato não suportado (${fileName}). Use PDF, DOCX, Markdown ou TXT.`,
  );
}

async function extractPdf(buffer: Buffer): Promise<string> {
  try {
    const mod = await import('pdf-parse');
    const PDFParse = (mod as { PDFParse?: new (opts: { data: Uint8Array }) => {
      getText: () => Promise<{ text?: string }>;
      destroy: () => Promise<void>;
    } }).PDFParse;
    if (PDFParse) {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const res = await parser.getText();
        const text = (res.text || '').trim();
        if (text) return text;
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    }
  } catch {
    // fallback abaixo
  }
  const fallback = extractPdfLiteralStrings(buffer);
  if (fallback.trim()) return fallback;
  throw new BadRequestException(
    'Não deu para ler texto deste PDF. PDFs escaneados (só imagem) precisam de OCR — anexe um TXT/Markdown.',
  );
}

async function extractDocx(buffer: Buffer): Promise<string> {
  try {
    const mod = await import('mammoth');
    const mammoth = mod as {
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value?: string }>;
    };
    const res = await mammoth.extractRawText({ buffer });
    const text = (res.value || '').trim();
    if (text) return text;
  } catch {
    // fall through
  }
  throw new BadRequestException(
    'Não deu para ler este DOCX. Exporte para PDF ou Markdown e anexe de novo.',
  );
}

/** Último recurso: puxa strings literais de um PDF simples. */
function extractPdfLiteralStrings(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const out: string[] = [];
  const re = /\((?:\\.|[^\\)]){3,}\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const piece = match[0]
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    if (/[A-Za-zÀ-ÿ0-9]{3,}/.test(piece)) out.push(piece);
  }
  return out.join(' ');
}

export function chunkText(text: string, size = 900, overlap = 120): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const breakAt = Math.max(
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('\n'),
        slice.lastIndexOf('. '),
      );
      if (breakAt > size * 0.4) end = i + breakAt + 1;
    }
    const piece = clean.slice(i, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks;
}
