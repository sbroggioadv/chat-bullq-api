import { InstagramMessageMapper } from './instagram.message-mapper';
import { MessageContentType } from '../../ports/types';

describe('InstagramMessageMapper — attachment types da Graph API', () => {
  const mapper = new InstagramMessageMapper();

  /**
   * Constrói um evento webhook de messaging no shape que a Meta envia.
   */
  const buildMessaging = (message: Record<string, any>) => ({
    sender: { id: 'sender_ig_id' },
    recipient: { id: 'our_ig_id' },
    timestamp: Date.now(),
    message,
  });

  describe('reels compartilhados (ig reel / ig_reel)', () => {
    it('extrai URL do reel compartilhado em vez de "[ig reel]"', () => {
      const link = 'https://www.instagram.com/reel/ABC123/';
      const msg = buildMessaging({
        mid: 'm_reel_1',
        attachments: [
          { type: 'ig reel', payload: { url: link, title: 'Meu reel' } },
        ],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res).not.toBeNull();
      expect(res!.content.text).toBe(link);
      expect(res!.content.text).not.toBe('[ig reel]');
    });

    it('extrai URL do reel com underscore ig_reel', () => {
      const link = 'https://www.instagram.com/reel/XYZ/';
      const msg = buildMessaging({
        mid: 'm_reel_2',
        attachments: [
          { type: 'ig_reel', payload: { url: link } },
        ],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.content.text).toBe(link);
    });

    it('mostra título quando não há URL', () => {
      const msg = buildMessaging({
        mid: 'm_reel_3',
        attachments: [
          { type: 'ig reel', payload: { title: 'Reel legal' } },
        ],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.content.text).toBe('Reel legal');
      expect(res!.content.text).not.toBe('[ig reel]');
    });
  });

  describe('posts/media compartilhados (ig_media / ig_post / ig_story / media)', () => {
    it('extrai URL de ig_media', () => {
      const link = 'https://www.instagram.com/p/ABC/';
      const msg = buildMessaging({
        mid: 'm_media',
        attachments: [{ type: 'ig_media', payload: { url: link } }],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.content.text).toBe(link);
    });

    it('extrai URL de ig_post com espaço', () => {
      const link = 'https://www.instagram.com/p/DEF/';
      const msg = buildMessaging({
        mid: 'm_post',
        attachments: [{ type: 'ig post', payload: { url: link } }],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.content.text).toBe(link);
    });

    it('extrai URL de media genérico', () => {
      const link = 'https://www.instagram.com/p/GHI/';
      const msg = buildMessaging({
        mid: 'm_gen',
        attachments: [{ type: 'media', payload: { url: link } }],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.content.text).toBe(link);
    });
  });

  describe('fall_back (mensagem não suportada pelo IG)', () => {
    it('extrai título do fall_back', () => {
      const msg = buildMessaging({
        mid: 'm_fb',
        attachments: [
          { type: 'fall_back', payload: { title: 'Mensagem não suportada' } },
        ],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.content.text).toContain('Mensagem não suportada');
      expect(res!.content.text).not.toBe('[fall_back]');
    });
  });

  describe('default tenta extrair URL antes de mostrar [type]', () => {
    it('extrai payload.url de tipo desconhecido', () => {
      const link = 'https://example.com/something';
      const msg = buildMessaging({
        mid: 'm_unknown',
        attachments: [{ type: 'future_type', payload: { url: link } }],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.content.text).toBe(link);
      expect(res!.content.text).not.toBe('[future_type]');
    });

    it('mostra [type] somente quando não há URL nem título', () => {
      const msg = buildMessaging({
        mid: 'm_empty',
        attachments: [{ type: 'weird_empty', payload: {} }],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.content.text).toBe('[weird_empty]');
    });
  });

  describe('mídia direta (regressão)', () => {
    it('image attachment classifica como IMAGE com mediaUrl', () => {
      const msg = buildMessaging({
        mid: 'm_img',
        attachments: [
          { type: 'image', payload: { url: 'https://cdn.instagram.com/img.jpg' } },
        ],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.type).toBe(MessageContentType.IMAGE);
      expect(res!.content.mediaUrl).toBe('https://cdn.instagram.com/img.jpg');
    });

    it('video attachment classifica como VIDEO com mediaUrl', () => {
      const msg = buildMessaging({
        mid: 'm_vid',
        attachments: [
          { type: 'video', payload: { url: 'https://cdn.instagram.com/vid.mp4' } },
        ],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.type).toBe(MessageContentType.VIDEO);
      expect(res!.content.mediaUrl).toBe('https://cdn.instagram.com/vid.mp4');
    });

    it('share attachment extrai URL como texto', () => {
      const link = 'https://www.instagram.com/p/SHARE/';
      const msg = buildMessaging({
        mid: 'm_share',
        attachments: [{ type: 'share', payload: { url: link } }],
      });
      const res = mapper.normalizeInbound(msg);
      expect(res!.content.text).toBe(link);
    });
  });
});
