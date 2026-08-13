import { chunkText, inferMime, isSupportedKnowledgeMime } from './extract-text';

describe('extract-text', () => {
  it('infere mime pela extensão', () => {
    expect(inferMime('manual.pdf', 'application/octet-stream')).toBe(
      'application/pdf',
    );
    expect(inferMime('regras.md', '')).toBe('text/markdown');
    expect(inferMime('faq.docx', '')).toContain('wordprocessingml');
  });

  it('aceita PDF/DOCX/MD/TXT', () => {
    expect(isSupportedKnowledgeMime('application/pdf', 'a.pdf')).toBe(true);
    expect(isSupportedKnowledgeMime('text/plain', 'a.txt')).toBe(true);
    expect(isSupportedKnowledgeMime('application/zip', 'a.zip')).toBe(false);
  });

  it('fatia texto longo sem perder o começo', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Parágrafo ${i}.`).join(
      '\n\n',
    );
    const chunks = chunkText(text, 80, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('Parágrafo 0');
    expect(chunks.join(' ')).toContain('Parágrafo 39');
  });

  it('texto curto vira um único chunk', () => {
    expect(chunkText('só isso')).toEqual(['só isso']);
  });
});
