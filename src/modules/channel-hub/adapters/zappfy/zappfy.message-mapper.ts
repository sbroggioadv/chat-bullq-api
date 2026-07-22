import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
  MessageContentType,
  StatusUpdate,
} from '../../ports/types';

@Injectable()
export class ZappfyMessageMapper {
  private readonly logger = new Logger(ZappfyMessageMapper.name);

  /**
   * Reescreve uma URL publica de upload (/uploads/documents/.../hash.zip)
   * para uma URL cujo path termina com o nome original do arquivo
   * (/uploads/media/nome-original.zip?key=documents/.../hash.zip).
   * Providers como Zappfy/Uazapi extraem o filename do path da URL, entao
   * essa rota faz com que o arquivo chegue no WhatsApp com o nome correto.
   */
  private inferFilenameFromUrl(publicUrl: string): string | null {
    try {
      const url = new URL(publicUrl);
      const segments = url.pathname.split('/');
      const last = segments[segments.length - 1];
      if (last && last.includes('.')) return decodeURIComponent(last);
    } catch {
      // ignore
    }
    return null;
  }

  private buildFriendlyMediaUrl(publicUrl: string, fileName: string): string {
    if (!publicUrl) return '';
    try {
      const url = new URL(publicUrl);
      const match = url.pathname.match(/\/api\/v1\/uploads\/(.+)$/);
      if (!match) return publicUrl;
      const key = match[1];
      url.pathname = `/api/v1/uploads/media/${encodeURIComponent(fileName)}`;
      url.searchParams.set('key', key);
      return url.toString();
    } catch {
      return publicUrl;
    }
  }

  normalizeInbound(event: any): NormalizedInboundMessage | null {
    const msg = event?.message;
    if (!msg) return null;

    const chatid = msg.chatid || '';
    const isGroup = chatid.endsWith('@g.us');
    const phone = chatid.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    const isEcho = msg.fromMe === true;

    // contactName resolution:
    //  - Group: chat name (the group's name).
    //  - 1-on-1 inbound (NOT fromMe): senderName / pushName comes from the
    //    contact's own WhatsApp profile = authoritative.
    //  - 1-on-1 echo (fromMe=true): both senderName AND event.chat.name come
    //    from the CONNECTED WhatsApp's address book — i.e. the OPERATOR's
    //    local label for the contact. That label is often wrong (we've seen
    //    "Luis Sbroggio" assigned to clients in the Doc's phone). Returning
    //    undefined here keeps the previously-stored profileName/contactName
    //    intact and lets a future inbound from the contact correct it via
    //    their real pushName.
    //
    // We also surface a `contactNameIsAuthoritative` hint on the result so
    // the resolver can safely overwrite a stale name without clobbering a
    // user-set one. See contact-resolver.service.ts.
    const resolvedContactName = isGroup
      ? event?.chat?.name || msg.chatName
      : isEcho
        ? undefined
        : msg.senderName || msg.pushName || undefined;

    const result: NormalizedInboundMessage = {
      externalMessageId: msg.messageid || msg.id || '',
      externalContactId: chatid,
      contactName: resolvedContactName,
      // Authoritative only when the name came from the CONTACT's own
      // WhatsApp profile via a non-echo inbound (msg.senderName/pushName).
      // Echo + group fall back to operator-side labels which are NOT
      // authoritative and shouldn't overwrite a stored name.
      contactNameIsAuthoritative:
        !isGroup && !isEcho && !!resolvedContactName,
      contactPhone: isGroup ? undefined : phone,
      channelType: ChannelType.WHATSAPP_ZAPPFY,
      timestamp: new Date(msg.messageTimestamp || Date.now()),
      type: this.resolveContentType(msg),
      content: this.extractContent(msg),
      isForwarded: typeof msg.content === 'object' && !!msg.content?.contextInfo?.isForwarded,
      isGroup,
      isEcho,
      senderName: isGroup
        ? (msg.senderName?.trim() || msg.pushName?.trim() || msg.sender_pn?.replace(/@.+/, '') || undefined)
        : (isEcho ? (msg.senderName?.trim() || msg.pushName?.trim() || undefined) : undefined),
      rawPayload: event,
    };

    if (typeof msg.content === 'object' && msg.content?.contextInfo?.stanzaId) {
      result.replyTo = {
        externalMessageId: msg.content.contextInfo.stanzaId,
      };
    }

    return result;
  }

  /**
   * Uazapi/Zappfy send status updates in at least two shapes:
   *  A) { state: 'delivered', event: { MessageIDs: [...], Timestamp, Type } }
   *  B) { event: 'messages.update', message: { messageid, status: 'READ' | ack:3, timestamp } }
   *  C) { messages: [{ id, ack: 3 }] }  (baileys-style numeric ack)
   *
   * We accept all of them and convert to our StatusUpdate.
   */
  normalizeStatus(event: any): StatusUpdate | null {
    if (!event) return null;

    const tsToDate = (ts: any): Date => {
      const num = typeof ts === 'string' ? parseInt(ts, 10) : Number(ts);
      if (!num || isNaN(num)) return new Date();
      return new Date(num > 9999999999 ? num : num * 1000);
    };

    const numericAckMap: Record<number, StatusUpdate['status']> = {
      1: 'sent',
      2: 'delivered',
      3: 'read',
      4: 'read',
      5: 'failed',
    };

    const stringStatusMap: Record<string, StatusUpdate['status']> = {
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      played: 'read',
      failed: 'failed',
      error: 'failed',
      pending: 'sent',
    };

    // Shape A
    const statusEvent = event?.event;
    if (statusEvent && Array.isArray(statusEvent.MessageIDs) && statusEvent.MessageIDs.length > 0) {
      const stateStr = String(event?.state || statusEvent?.Type || '').toLowerCase();
      const status = stringStatusMap[stateStr];
      if (status) {
        return {
          externalMessageId: String(statusEvent.MessageIDs[0]),
          status,
          timestamp: tsToDate(statusEvent?.Timestamp),
        };
      }
    }

    // Shape B
    const bMsg = event?.message;
    if (bMsg && (bMsg.messageid || bMsg.id)) {
      const stateStr = String(bMsg.status || event?.state || '').toLowerCase();
      const numeric = typeof bMsg.ack === 'number' ? bMsg.ack : undefined;
      const status =
        numeric !== undefined ? numericAckMap[numeric] : stringStatusMap[stateStr];
      if (status) {
        return {
          externalMessageId: String(bMsg.messageid || bMsg.id),
          status,
          timestamp: tsToDate(bMsg.timestamp || bMsg.messageTimestamp),
        };
      }
    }

    // Shape C
    if (Array.isArray(event?.messages)) {
      const first = event.messages.find((m: any) => m?.id && (m.ack != null || m.status));
      if (first) {
        const numeric = typeof first.ack === 'number' ? first.ack : undefined;
        const status =
          numeric !== undefined
            ? numericAckMap[numeric]
            : stringStatusMap[String(first.status || '').toLowerCase()];
        if (status) {
          return {
            externalMessageId: String(first.id),
            status,
            timestamp: tsToDate(first.timestamp),
          };
        }
      }
    }

    return null;
  }

  denormalize(
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): {
    endpoint: string;
    payload: Record<string, any>;
    fileUpload?: {
      url: string;
      name: string;
      mimeType?: string;
      friendlyUrl?: string;
    };
  } {
    const number = contactExternalId.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    // Uazapi/Zappfy aceita `replyid` (id da mensagem citada) em
    // /send/text e /send/media. Quando o cliente recebe, o WhatsApp
    // renderiza a "bolha de resposta" nativa em cima da nossa mensagem.
    // Sem isso, o reply seria apenas textual e perderia o link visual.
    const replyId = message.replyTo?.externalMessageId;
    const withReply = <T extends Record<string, any>>(p: T): T =>
      replyId ? ({ ...p, replyid: replyId } as T) : p;

    switch (message.type) {
      case MessageContentType.TEXT:
        return {
          endpoint: '/send/text',
          payload: withReply({ number, text: message.content.text, delay: 1000 }),
        };

      case MessageContentType.IMAGE: {
        const imageUrl = message.content.mediaUrl || '';
        const imageName = message.content.fileName || this.inferFilenameFromUrl(imageUrl) || 'image.jpg';
        const friendlyUrl = this.buildFriendlyMediaUrl(imageUrl, imageName);
        const imagePayload = withReply({
          number,
          file: friendlyUrl,
          type: 'image',
          caption: message.content.caption || '',
        });
        // Prefer multipart when we have an original name so WA keeps it.
        if (message.content.fileName && imageUrl) {
          return {
            endpoint: '/send/media',
            payload: imagePayload,
            fileUpload: {
              url: imageUrl,
              name: imageName,
              mimeType: message.content.mimeType,
              friendlyUrl,
            },
          };
        }
        return { endpoint: '/send/media', payload: imagePayload };
      }

      case MessageContentType.AUDIO:
        return {
          endpoint: '/send/media',
          payload: withReply({
            number,
            file: message.content.mediaUrl,
            // "ptt" renders as a native voice note on WhatsApp. "audio" would
            // render as a forwarded audio file, which is wrong UX for a
            // message the user just recorded in the app.
            type: 'ptt',
          }),
        };

      case MessageContentType.VIDEO: {
        const videoUrl = message.content.mediaUrl || '';
        const videoName = message.content.fileName || this.inferFilenameFromUrl(videoUrl) || 'video.mp4';
        const friendlyUrl = this.buildFriendlyMediaUrl(videoUrl, videoName);
        const videoPayload = withReply({
          number,
          file: friendlyUrl,
          type: 'video',
          caption: message.content.caption || '',
        });
        if (message.content.fileName && videoUrl) {
          return {
            endpoint: '/send/media',
            payload: videoPayload,
            fileUpload: {
              url: videoUrl,
              name: videoName,
              mimeType: message.content.mimeType,
              friendlyUrl,
            },
          };
        }
        return { endpoint: '/send/media', payload: videoPayload };
      }

      case MessageContentType.DOCUMENT: {
        // SPEC-003 W2: Zappfy ignores "filename" on JSON URL sends and often
        // uses the storage hash. Send multipart with the original name; keep
        // friendly URL as fallback in the outbound adapter.
        const originalUrl = message.content.mediaUrl || '';
        const fileName =
          message.content.fileName ||
          this.inferFilenameFromUrl(originalUrl) ||
          'document.bin';
        const friendlyUrl = this.buildFriendlyMediaUrl(originalUrl, fileName);
        const docPayload = withReply({
          number,
          file: friendlyUrl,
          type: 'document',
          caption: message.content.caption || '',
          // Extra hints some Uazapi builds honor when present:
          filename: fileName,
          docName: fileName,
        });
        this.logger.log(
          `DOCUMENT payload to Zappfy for ${number}: ${JSON.stringify({
            ...docPayload,
            mode: originalUrl ? 'multipart+friendly-fallback' : 'json-only',
            fileName,
          })}`,
        );
        return {
          endpoint: '/send/media',
          payload: docPayload,
          fileUpload: originalUrl
            ? {
                url: originalUrl,
                name: fileName,
                mimeType: message.content.mimeType,
                friendlyUrl,
              }
            : undefined,
        };
      }

      case MessageContentType.CONTACT: {
        // S21 W3 / SPEC-003: share vCard. Uazapi/Zappfy typically accept
        // /send/contact with number + fullName + phone (or vcard string).
        const contact = message.content.contact;
        const fullName =
          contact?.fullName || message.content.text || 'Contato';
        const phone =
          contact?.phones?.[0]?.replace(/\D/g, '') ||
          number;
        const vcard =
          contact?.vcard ||
          [
            'BEGIN:VCARD',
            'VERSION:3.0',
            `FN:${fullName}`,
            phone ? `TEL;type=CELL;type=VOICE;waid=${phone}:+${phone}` : '',
            'END:VCARD',
          ]
            .filter(Boolean)
            .join('\n');
        return {
          endpoint: '/send/contact',
          payload: withReply({
            number,
            fullName,
            phoneName: fullName,
            phone,
            vcard,
          }),
        };
      }

      case MessageContentType.STICKER:
        return {
          endpoint: '/send/media',
          payload: withReply({
            number,
            file: message.content.mediaUrl,
            type: 'sticker',
          }),
        };

      case MessageContentType.LOCATION:
        return {
          endpoint: '/send/location',
          payload: withReply({
            number,
            latitude: String(message.content.latitude),
            longitude: String(message.content.longitude),
            name: message.content.text || '',
            address: '',
          }),
        };

      case MessageContentType.REACTION:
        // Reaction já É um reply intrínseco a uma msg específica via
        // targetMessageId — replyid não se aplica aqui.
        return {
          endpoint: '/message/react',
          payload: {
            chatid: contactExternalId,
            messageid: message.content.reaction?.targetMessageId,
            reaction: message.content.reaction?.emoji,
          },
        };

      default:
        return {
          endpoint: '/send/text',
          payload: withReply({ number, text: message.content.text || '' }),
        };
    }
  }

  private resolveContentType(msg: any): MessageContentType {
    const type = (msg.messageType || '').toLowerCase();
    if (type.includes('text') || type === 'conversation' || type === 'extendedtextmessage')
      return MessageContentType.TEXT;
    if (type.includes('image')) return MessageContentType.IMAGE;
    if (type.includes('audio') || type.includes('ptt')) return MessageContentType.AUDIO;
    if (type.includes('video')) return MessageContentType.VIDEO;
    if (type.includes('document')) return MessageContentType.DOCUMENT;
    if (type.includes('sticker')) return MessageContentType.STICKER;
    if (type.includes('location')) return MessageContentType.LOCATION;
    if (type.includes('reaction')) return MessageContentType.REACTION;
    if (type.includes('button') || type.includes('list')) return MessageContentType.INTERACTIVE;
    if (
      type.includes('interactive') ||
      type.includes('nativeflow') ||
      type.includes('template')
    ) {
      return MessageContentType.INTERACTIVE;
    }
    if (type.includes('contact') || type.includes('vcard')) {
      return MessageContentType.CONTACT;
    }
    // viewOnce: embrulha outra mensagem em `content.message`. Classifica
    // pelo tipo interno pra frontend renderizar mídia em vez de texto.
    if (type.includes('viewonce')) {
      const inner = msg?.content?.message || msg?.content || {};
      if (inner.imageMessage || inner.image) return MessageContentType.IMAGE;
      if (inner.videoMessage || inner.video) return MessageContentType.VIDEO;
      if (inner.audioMessage || inner.ptvMessage || inner.audio) return MessageContentType.AUDIO;
      if (inner.documentMessage || inner.document) return MessageContentType.DOCUMENT;
      if (inner.stickerMessage || inner.sticker) return MessageContentType.STICKER;
      return MessageContentType.TEXT;
    }
    return MessageContentType.TEXT;
  }

  private extractContent(msg: any): NormalizedInboundMessage['content'] {
    const raw = msg.content;
    const type = (msg.messageType || '').toLowerCase();

    // Zappfy sends content as plain string for Conversation type
    if (typeof raw === 'string') {
      return { text: raw };
    }

    const content = raw || {};

    if (type.includes('text') || type === 'conversation' || type === 'extendedtextmessage') {
      return { text: content.text || content.conversation || '' };
    }
    if (type.includes('image')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
        fileSize: content.fileLength,
        caption: content.caption,
      };
    }
    if (type.includes('audio') || type.includes('ptt')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
        fileSize: content.fileLength,
      };
    }
    if (type.includes('video')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
        fileSize: content.fileLength,
        caption: content.caption,
      };
    }
    if (type.includes('document')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
        fileName: content.fileName,
        fileSize: content.fileLength,
        caption: content.caption,
      };
    }
    if (type.includes('sticker')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
      };
    }

    // viewOnceMessage / viewOnceMessageV2 envolvem outra mensagem em
    // `content.message`. Desembrulhamos o tipo interno de mídia aqui para
    // preservar a classificação (IMAGE/VIDEO/AUDIO) e a URL — sem isso,
 // a mídia efêmera caía no fallback e virava "[Unsupported message type]".
    if (type.includes('viewonce')) {
      return this.extractViewOnceContent(msg);
    }

    // Chatbot/automações: botões, listas, templates, interactive, nativeFlow.
    // Extrai texto legível (cabeçalho + botões/itens) pra `content.text`.
    // A UI não renderiza botões clicáveis ainda — texto é a degradação.
    if (
      type.includes('button') ||
      type.includes('list') ||
      type.includes('interactive') ||
      type.includes('nativeflow') ||
      type.includes('template')
    ) {
      return this.extractInteractiveContent(content);
    }

    // vCard / contato: nome + telefones.
    if (type.includes('contact')) {
      return this.extractContactContent(content);
    }

    // orderMessage: catálogo/pedido. Texto curto com título e total.
    if (type.includes('order')) {
      return this.extractOrderContent(content);
    }

    // systemMessage / protocolMessage: normalmente texto puro.
    if (type.includes('system') || type.includes('protocol')) {
      return { text: content.text || content.system || content.conversation || '' };
    }

    if (type.includes('location')) {
      return {
        latitude: content.degreesLatitude,
        longitude: content.degreesLongitude,
        text: content.name || content.address,
      };
    }
    if (type.includes('reaction')) {
      return {
        reaction: {
          emoji: content.text || msg.text || '',
          targetMessageId: msg.reaction || content.key?.ID || '',
        },
      };
    }
    // Fallback final: preserva o messageType real em vez de "Unsupported".
    // O operador vê o tipo e devs conseguem localizar na doc quando surgir
    // novo formato. Nunca perde informação.
    const rawType = msg.messageType || 'desconhecido';
    return { text: content.text || `[Tipo: ${rawType}]` };
  }

  /**
   * Desembrulha `viewOnceMessage[V2]`: o conteúdo real vive em
   * `content.message.<tipo>Message` (image/video/audio/etc.). Retorna a
   * mesma estrutura que o handler do tipo específico produziria.
   */
  private extractViewOnceContent(msg: any): NormalizedInboundMessage['content'] {
    const content = (typeof msg.content === 'object' && msg.content) || {};
    const inner = content.message || content;

    const pick = (m: any): NormalizedInboundMessage['content'] => ({
      mediaUrl: m?.url || m?.mediaUrl,
      mimeType: m?.mimetype,
      fileSize: m?.fileLength,
      caption: m?.caption,
    });

    if (inner?.imageMessage || inner?.image) return pick(inner.imageMessage || inner.image);
    if (inner?.videoMessage || inner?.video) return pick(inner.videoMessage || inner.video);
    if (inner?.audioMessage || inner?.ptvMessage || inner?.audio) {
      return pick(inner.audioMessage || inner.ptvMessage || inner.audio);
    }
    if (inner?.documentMessage || inner?.document) {
      const d = inner.documentMessage || inner.document;
      return { ...pick(d), fileName: d?.fileName };
    }
    if (inner?.stickerMessage || inner?.sticker) {
      return pick(inner.stickerMessage || inner.sticker);
    }

    // View-once de texto (raro, mas existe): apenas desembrulha.
    const text = inner?.text || inner?.conversation || inner?.caption || content.text || '';
    return { text: text || '[Tipo: viewOnceMessage]' };
  }

  /**
   * Botões, listas, templates, interactive, nativeFlow. A Uazapi/Zappfy
   * entrega `content` em pelo menos dois shapes:
   *   (a) achatado: `content.caption`, `content.buttons`, `content.sections`
   *   (b) baileys-shape: `content.contentText.{caption,title,buttons,sections}`
   * Cobrimos ambos pra não acoplar a uma versão específica do provider.
   */
  private extractInteractiveContent(content: any): NormalizedInboundMessage['content'] {
    const ctx = content?.contentText || content || {};
    const header =
      ctx.caption || ctx.text || ctx.title || ctx.header || ctx.heading || '';
    const description =
      ctx.description || ctx.subtitle || ctx.footerText || ctx.footer || '';

    const buttonLabels: string[] = (ctx.buttons || [])
      .map((b: any) =>
        b?.buttonText?.displayText || b?.displayText || b?.title || b?.text || '',
      )
      .filter((s: string) => !!s);

    const itemLabels: string[] = [];
    const sections = ctx.sections || ctx.list || [];
    if (Array.isArray(sections)) {
      for (const sec of sections) {
        if (Array.isArray(sec?.rows)) {
          for (const row of sec.rows) {
            if (row?.title) itemLabels.push(String(row.title));
          }
        } else if (sec?.title) {
          itemLabels.push(String(sec.title));
        }
      }
    }

    const parts: string[] = [];
    if (header) parts.push(String(header));
    if (description) parts.push(String(description));
    if (buttonLabels.length) parts.push(`Opções: ${buttonLabels.join(' | ')}`);
    if (itemLabels.length) parts.push(`Itens: ${itemLabels.join(' | ')}`);

    return { text: parts.join('\n') || content?.text || '' };
  }

  /**
   * contactMessage / contactsArrayMessage: vCard(s). Extrai nome (FN) +
   * telefones (TEL). Cobre shape flat e array multi-contato (Baileys /
   * Uazapi: content.contacts[] ou content.message.contacts).
   */
  private extractContactContent(content: any): NormalizedInboundMessage['content'] {
    const entries = this.collectContactEntries(content);
    if (entries.length === 0) {
      return { text: 'Contato' };
    }

    const lines: string[] = [];
    const first = entries[0];
    for (const e of entries) {
      const label = e.fullName || 'Contato';
      const telPart = e.phones.length ? ` (${e.phones.join(', ')})` : '';
      lines.push(`${label}${telPart}`);
    }

    const text =
      entries.length === 1
        ? `Contato: ${lines[0]}`
        : `Contatos (${entries.length}):\n${lines.map((l) => `• ${l}`).join('\n')}`;

    return {
      text,
      fileName: `${first.fullName || 'contato'}.vcf`,
      contact: {
        fullName: first.fullName || 'Contato',
        phones: first.phones,
        vcard: first.vcard,
      },
    };
  }

  private collectContactEntries(
    content: any,
  ): Array<{ fullName: string; phones: string[]; vcard?: string }> {
    const out: Array<{ fullName: string; phones: string[]; vcard?: string }> = [];
    const pushFrom = (item: any) => {
      if (!item || typeof item !== 'object') return;
      const vcard =
        (typeof item.vcard === 'string' && item.vcard) ||
        (typeof item.vCard === 'string' && item.vCard) ||
        (typeof item.vcardString === 'string' && item.vcardString) ||
        '';
      let fullName =
        item.displayName ||
        item.name ||
        item.contactName ||
        item.fullName ||
        '';
      if (!fullName && typeof item === 'object' && item.firstName) {
        fullName = [item.firstName, item.lastName].filter(Boolean).join(' ');
      }
      const phones = this.extractPhonesFromVcardOrFields(vcard, item);
      if (vcard && !fullName) {
        const fn = vcard.match(/^FN:(.+)$/im);
        if (fn) fullName = fn[1].trim();
      }
      if (fullName || phones.length || vcard) {
        out.push({ fullName: fullName || '', phones, vcard: vcard || undefined });
      }
    };

    // Multi-contato: contacts / contactsArray / message.contacts
    const arrays = [
      content?.contacts,
      content?.contactsArray,
      content?.contactArray,
      content?.message?.contacts,
      content?.contentText?.contacts,
    ].filter(Array.isArray) as any[][];

    for (const arr of arrays) {
      for (const item of arr) pushFrom(item);
    }

    // Flat single contact
    if (out.length === 0) {
      pushFrom(content);
    }

    return out;
  }

  private extractPhonesFromVcardOrFields(vcard: string, item: any): string[] {
    const tels: string[] = [];
    if (typeof vcard === 'string' && vcard) {
      for (const line of vcard.split(/\r?\n/)) {
        const m = line.match(/^TEL[^:]*:(.+)$/i);
        if (m) {
          const num = m[1].trim();
          if (num) tels.push(num);
        }
      }
    }
    const extras = [
      item?.phone,
      item?.number,
      item?.waid,
      ...(Array.isArray(item?.phones) ? item.phones : []),
    ];
    for (const p of extras) {
      if (typeof p === 'string' && p.trim()) tels.push(p.trim());
      if (typeof p === 'object' && p?.phone) tels.push(String(p.phone));
    }
    return [...new Set(tels)];
  }

  /**
   * orderMessage: pedido de catálogo do WhatsApp. Traz título, itens,
   * total e mensagem opcional. Sinalizamos como texto curto.
   */
  private extractOrderContent(content: any): NormalizedInboundMessage['content'] {
    const orderTitle = content?.orderTitle || content?.title || '';
    const message = content?.message || '';
    const items = Array.isArray(content?.items) ? content.items : [];
    const itemCount = items.length;
    const totalRaw =
      content?.total_amount ?? content?.totalAmount ?? content?.total ?? 0;
    const total = Number(totalRaw) || 0;

    const parts: string[] = [];
    parts.push(orderTitle ? `Pedido: ${orderTitle}` : 'Pedido');
    if (itemCount) parts.push(`${itemCount} item(ns)`);
    if (total > 0) {
      // WhatsApp envia total em centavos (integer). Se vier pequeno, mostramos
      // cru pra não inventar casa decimal errada.
      const formatted = total >= 100 ? (total / 100).toFixed(2) : String(total);
      parts.push(`Total: ${formatted}`);
    }
    if (message) parts.push(String(message));
    return { text: parts.join('\n') };
  }
}
