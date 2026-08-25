import {
  historicoSensivel,
  MAX_ATTACHMENT_BYTES,
  mimePermitido,
  montarHistorico,
  sanitizarFilename,
  validarIncorporacao,
} from './incorporacao';

describe('incorporação W3', () => {
  it('XOR: comment+message, attachment+message, attachment+document; recusa os dois kinds/ids', () => {
    expect(validarIncorporacao({ kind: 'comment', messageId: 'msg-1' }).ok).toBe(true);
    expect(validarIncorporacao({ kind: 'attachment', messageId: 'msg-1' }).ok).toBe(true);
    expect(validarIncorporacao({ kind: 'attachment', documentId: 'doc-1' }).ok).toBe(true);
    expect(validarIncorporacao({ kind: 'comment', messageId: 'msg-1', documentId: 'doc-1' }).ok).toBe(false);
    expect(validarIncorporacao({ kind: 'attachment', messageId: 'msg-1', documentId: 'doc-1' }).ok).toBe(false);
    expect(validarIncorporacao({ kind: 'comment' }).ok).toBe(false);
    expect(validarIncorporacao({ kind: 'comment', documentId: 'doc-1' }).ok).toBe(false);
  });

  it('MIME allow/deny e filename sanitizado', () => {
    expect(mimePermitido('application/pdf', 'contrato.pdf')).toBe(true);
    expect(mimePermitido('image/jpeg', 'foto.jpg')).toBe(true);
    expect(mimePermitido('application/x-msdownload', 'x.exe')).toBe(false);
    expect(mimePermitido('application/octet-stream', 'x.bin')).toBe(false);
    expect(mimePermitido('application/octet-stream', 'ok.pdf')).toBe(true);
    expect(mimePermitido('', 'a.pdf')).toBe(false);
    expect(sanitizarFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizarFilename('')).toBe('anexo');
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
  });

  it('histórico usa tz America/Sao_Paulo e recusa texto sensível', () => {
    const bloco = montarHistorico({
      quando: new Date('2026-08-25T21:00:00.000Z'),
      senderName: 'Maria',
      direcao: 'INBOUND',
      texto: 'contrato assinado',
    });
    expect(bloco).toContain('🔄 histórico da conversa · via inbox');
    expect(bloco).toContain('Maria: contrato assinado');
    expect(bloco).toMatch(/\[2026-08-25T18:00:00-03:00\]/);
    expect(historicoSensivel('desconto de 40%')).toBe(true);
  });
});
