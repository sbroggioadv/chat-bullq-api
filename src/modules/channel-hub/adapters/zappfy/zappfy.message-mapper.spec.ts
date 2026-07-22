import { ZappfyMessageMapper } from './zappfy.message-mapper';
import { MessageContentType } from '../../ports/types';

describe('ZappfyMessageMapper — chatbot/automação inbound', () => {
  const mapper = new ZappfyMessageMapper();

  /**
   * Helper: constrói um inbound event no shape que a Uazapi/Zappfy entrega.
   * `content` pode ser string (Conversation) ou objeto. `messageType` é o
   * discriminador que o provider envia no campo homônimo.
   */
  const buildEvent = (messageType: string, content: any, extra: Record<string, any> = {}) => ({
    message: {
      messageid: 'mid_' + Math.random().toString(36).slice(2),
      chatid: '5511999999999@s.whatsapp.net',
      messageTimestamp: Date.now(),
      messageType,
      content,
      ...extra,
    },
  });

  describe('buttonsMessage / interactive / nativeFlow', () => {
    it('extrai caption + títulos dos botões (shape achatado)', () => {
      const event = buildEvent('buttonsMessage', {
        caption: 'Escolha uma opção:',
        buttons: [
          { buttonText: { displayText: 'Sim' } },
          { buttonText: { displayText: 'Não' } },
        ],
      });
      const res = mapper.normalizeInbound(event);
      expect(res).not.toBeNull();
      expect(res!.type).toBe(MessageContentType.INTERACTIVE);
      expect(res!.content.text).toContain('Escolha uma opção:');
      expect(res!.content.text).toContain('Sim');
      expect(res!.content.text).toContain('Não');
      expect(res!.content.text).not.toContain('[Unsupported');
    });

    it('extrai header + botões (shape baileys contentText aninhado)', () => {
      const event = buildEvent('interactiveMessage', {
        contentText: {
          header: 'Confirma o agendamento?',
          buttons: [
            { buttonText: { displayText: 'Confirmar' } },
            { buttonText: { displayText: 'Remarcar' } },
          ],
        },
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.content.text).toContain('Confirma o agendamento?');
      expect(res!.content.text).toContain('Confirmar');
      expect(res!.content.text).toContain('Remarcar');
    });

    it('lida com botões sem displayText gracefully', () => {
      const event = buildEvent('buttonsMessage', {
        caption: 'Olá',
        buttons: [{ weirdShape: true }, { buttonText: { displayText: 'OK' } }],
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.content.text).toContain('Olá');
      expect(res!.content.text).toContain('OK');
      // botão inválido não vira string vazia visível
      expect(res!.content.text).not.toContain(' |  |');
    });
  });

  describe('listMessage', () => {
    it('extrai título + itens das sections', () => {
      const event = buildEvent('listMessage', {
        contentText: {
          title: 'Menu principal',
          description: 'Selecione uma categoria',
          sections: [
            {
              title: 'Vendas',
              rows: [{ title: 'Novo plano' }, { title: 'Renovar' }],
            },
            {
              title: 'Suporte',
              rows: [{ title: 'Falar com humano' }],
            },
          ],
        },
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.type).toBe(MessageContentType.INTERACTIVE);
      expect(res!.content.text).toContain('Menu principal');
      expect(res!.content.text).toContain('Novo plano');
      expect(res!.content.text).toContain('Renovar');
      expect(res!.content.text).toContain('Falar com humano');
      expect(res!.content.text).not.toContain('[Unsupported');
    });
  });

  describe('contactMessage (vCard)', () => {
    it('extrai nome + telefones do vCard', () => {
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:João da Silva',
        'TEL;type=CELL;type=VOICE;waid=5511999998888:+55 11 99999-8888',
        'TEL;type=HOME:+55 11 3333-2222',
        'END:VCARD',
      ].join('\n');
      const event = buildEvent('contactMessage', {
        displayName: 'João da Silva',
        vcard,
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.type).toBe(MessageContentType.CONTACT);
      expect(res!.content.text).toContain('João da Silva');
      expect(res!.content.text).toContain('+55 11 99999-8888');
      expect(res!.content.text).toContain('+55 11 3333-2222');
      expect(res!.content.fileName).toBe('João da Silva.vcf');
      expect(res!.content.contact?.fullName).toBe('João da Silva');
    });

    it('lida com vCard ausente mostrando só o nome', () => {
      const event = buildEvent('contactMessage', {
        displayName: 'Maria',
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.type).toBe(MessageContentType.CONTACT);
      expect(res!.content.text).toContain('Maria');
      expect(res!.content.text).not.toContain('Tel:');
    });

    it('contactsArrayMessage extrai múltiplos contatos', () => {
      const event = buildEvent('contactsArrayMessage', {
        contacts: [
          {
            displayName: 'Alice',
            vcard: 'BEGIN:VCARD\nFN:Alice\nTEL:+5511999000111\nEND:VCARD',
          },
          {
            displayName: 'Bob',
            vcard: 'BEGIN:VCARD\nFN:Bob\nTEL:+5511888000222\nEND:VCARD',
          },
        ],
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.type).toBe(MessageContentType.CONTACT);
      expect(res!.content.text).toContain('Contatos (2)');
      expect(res!.content.text).toContain('Alice');
      expect(res!.content.text).toContain('Bob');
      expect(res!.content.text).toContain('+5511999000111');
    });
  });

  describe('denormalize DOCUMENT multipart', () => {
    it('retorna fileUpload com nome original', () => {
      const result = mapper.denormalize(
        {
          type: MessageContentType.DOCUMENT,
          content: {
            mediaUrl: 'https://api.example.com/api/v1/uploads/documents/2026-07-22/abc123.pdf',
            fileName: 'Contrato-Cliente.pdf',
            mimeType: 'application/pdf',
          },
        },
        '5511999998888@s.whatsapp.net',
      );
      expect(result.endpoint).toBe('/send/media');
      expect(result.fileUpload?.name).toBe('Contrato-Cliente.pdf');
      expect(result.fileUpload?.url).toContain('uploads/documents');
      expect(result.payload.type).toBe('document');
      expect(result.payload.filename).toBe('Contrato-Cliente.pdf');
    });
  });

  describe('orderMessage', () => {
    it('extrai título, itens e total', () => {
      const event = buildEvent('orderMessage', {
        orderTitle: 'Pedido #42',
        message: 'Confirme o envio',
        total_amount: 12990,
        items: [{ name: 'Curso', quantity: 1, price: 12990 }],
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.content.text).toContain('Pedido #42');
      expect(res!.content.text).toContain('1 item(ns)');
      expect(res!.content.text).toContain('129.90');
      expect(res!.content.text).toContain('Confirme o envio');
    });

    it('lida com pedido sem total gracefully', () => {
      const event = buildEvent('orderMessage', {
        orderTitle: 'Catálogo',
        items: [{ name: 'X' }],
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.content.text).toContain('Catálogo');
      expect(res!.content.text).toContain('1 item(ns)');
      expect(res!.content.text).not.toContain('Total:');
    });
  });

  describe('viewOnceMessage', () => {
    it('classifica como IMAGE e extrai mídia embutida (imageMessage)', () => {
      const event = buildEvent('viewOnceMessage', {
        message: {
          imageMessage: {
            url: 'https://mmg.whatsapp.net/dummy/img.jpg',
            mimetype: 'image/jpeg',
            caption: 'Foto efêmera',
            fileLength: 12345,
          },
        },
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.type).toBe(MessageContentType.IMAGE);
      expect(res!.content.mediaUrl).toBe('https://mmg.whatsapp.net/dummy/img.jpg');
      expect(res!.content.mimeType).toBe('image/jpeg');
      expect(res!.content.caption).toBe('Foto efêmera');
    });

    it('classifica como VIDEO quando inner é videoMessage', () => {
      const event = buildEvent('viewOnceMessageV2', {
        message: {
          videoMessage: {
            url: 'https://mmg.whatsapp.net/dummy/v.mp4',
            mimetype: 'video/mp4',
          },
        },
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.type).toBe(MessageContentType.VIDEO);
      expect(res!.content.mediaUrl).toContain('v.mp4');
    });

    it('classifica como AUDIO quando inner é audioMessage/ptvMessage', () => {
      const event = buildEvent('viewOnceMessage', {
        message: {
          ptvMessage: {
            url: 'https://mmg.whatsapp.net/dummy/a.mp4',
            mimetype: 'audio/mp4',
          },
        },
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.type).toBe(MessageContentType.AUDIO);
    });
  });

  describe('systemMessage / protocolMessage', () => {
    it('extrai texto de systemMessage', () => {
      const event = buildEvent('systemMessage', {
        text: 'Grupo criado',
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.content.text).toBe('Grupo criado');
    });

    it('extrai system de protocolMessage', () => {
      const event = buildEvent('protocolMessage', {
        system: 'Mensagem revogada',
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.content.text).toBe('Mensagem revogada');
    });
  });

  describe('fallback preserva o tipo real (nunca perde informação)', () => {
    it('mostra "[Tipo: <messageType>]" quando o tipo é desconhecido', () => {
      const event = buildEvent('someNewFutureMessageType', {
        foo: 'bar',
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.content.text).toBe('[Tipo: someNewFutureMessageType]');
      // Nunca mais "Unsupported message type"
      expect(res!.content.text).not.toMatch(/Unsupported/i);
    });

    it('preserva content.text quando tipo é desconhecido mas há texto', () => {
      const event = buildEvent('weirdType', {
        text: 'Algum texto útil',
      });
      const res = mapper.normalizeInbound(event);
      expect(res!.content.text).toBe('Algum texto útil');
    });
  });
});

describe('ZappfyMessageMapper — regressão dos tipos hoje suportados', () => {
  const mapper = new ZappfyMessageMapper();

  const buildEvent = (messageType: string, content: any) => ({
    message: {
      messageid: 'm_reg_' + Math.random().toString(36).slice(2),
      chatid: '5511999999999@s.whatsapp.net',
      messageTimestamp: Date.now(),
      messageType,
      content,
    },
  });

  it('TEXT: preserva texto', () => {
    const res = mapper.normalizeInbound(buildEvent('conversation', 'Olá mundo'));
    expect(res!.type).toBe(MessageContentType.TEXT);
    expect(res!.content.text).toBe('Olá mundo');
  });

  it('IMAGE: preserva mídia', () => {
    const res = mapper.normalizeInbound(
      buildEvent('imageMessage', { url: 'https://x/i.jpg', mimetype: 'image/jpeg' }),
    );
    expect(res!.type).toBe(MessageContentType.IMAGE);
    expect(res!.content.mediaUrl).toBe('https://x/i.jpg');
  });

  it('AUDIO: preserva áudio', () => {
    const res = mapper.normalizeInbound(
      buildEvent('audioMessage', { url: 'https://x/a.mp3', mimetype: 'audio/mpeg' }),
    );
    expect(res!.type).toBe(MessageContentType.AUDIO);
  });

  it('VIDEO: preserva vídeo', () => {
    const res = mapper.normalizeInbound(
      buildEvent('videoMessage', { url: 'https://x/v.mp4', mimetype: 'video/mp4' }),
    );
    expect(res!.type).toBe(MessageContentType.VIDEO);
  });

  it('DOCUMENT: preserva documento', () => {
    const res = mapper.normalizeInbound(
      buildEvent('documentMessage', {
        url: 'https://x/d.pdf',
        mimetype: 'application/pdf',
        fileName: 'contrato.pdf',
      }),
    );
    expect(res!.type).toBe(MessageContentType.DOCUMENT);
    expect(res!.content.fileName).toBe('contrato.pdf');
  });

  it('LOCATION: preserva geo', () => {
    const res = mapper.normalizeInbound(
      buildEvent('locationMessage', {
        degreesLatitude: -23.5,
        degreesLongitude: -46.6,
        name: 'Escritório',
      }),
    );
    expect(res!.type).toBe(MessageContentType.LOCATION);
    expect(res!.content.latitude).toBe(-23.5);
    expect(res!.content.longitude).toBe(-46.6);
  });

  it('REACTION: preserva emoji', () => {
    const res = mapper.normalizeInbound(
      buildEvent('reactionMessage', {
        text: '👍',
        key: { ID: 'target_msg_id' },
      }),
    );
    expect(res!.type).toBe(MessageContentType.REACTION);
    expect(res!.content.reaction?.emoji).toBe('👍');
  });

  it('STICKER: preserva sticker', () => {
    const res = mapper.normalizeInbound(
      buildEvent('stickerMessage', { url: 'https://x/s.webp', mimetype: 'image/webp' }),
    );
    expect(res!.type).toBe(MessageContentType.STICKER);
  });
});
