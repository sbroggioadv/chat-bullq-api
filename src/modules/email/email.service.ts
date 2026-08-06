import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  ChannelAccess,
  ChannelAccessService,
} from '../iam/channel-access/channel-access.service';
import {
  GmailHttpClient,
  GmailLabel,
} from '../channel-hub/adapters/gmail/gmail.http-client';
import {
  extractAddress,
  extractAddresses,
  extractAttachments,
  extractBody,
  headerOf,
} from '../channel-hub/adapters/gmail/gmail.message-mapper';

export interface EmailFolder {
  id: string;
  name: string;
  kind: 'system' | 'user';
}

export interface EmailThreadSummary {
  id: string;
  externalConversationId: string;
  subject: string;
  from: { email: string; name?: string };
  snippet: string;
  date: string | null;
  unread: boolean;
}

const SYSTEM_FOLDERS: EmailFolder[] = [
  { id: 'INBOX', name: 'Caixa de entrada', kind: 'system' },
  { id: 'SENT', name: 'Enviados', kind: 'system' },
  { id: 'SPAM', name: 'Spam', kind: 'system' },
];

const LABELS_TTL_MS = 5 * 60_000;
const MAX_USER_LABELS = 40;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

/**
 * Leitura de e-mail (SPEC-004 W1, readonly) — pastas/labels e threads direto
 * da API do Gmail, sempre escopado a canal GMAIL da org com ChannelAccess.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly labelsCache = new Map<
    string,
    { at: number; labels: GmailLabel[] }
  >();
  private readonly profileCache = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessService,
    private readonly gmail: GmailHttpClient,
  ) {}

  private async accessibleGmailChannels(
    organizationId: string,
    access: ChannelAccess,
  ): Promise<Channel[]> {
    const channels = await this.prisma.channel.findMany({
      where: {
        organizationId,
        type: ChannelType.GMAIL,
        isActive: true,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
    return channels.filter((c) => this.channelAccess.hasAccess(access, c.id));
  }

  async status(organizationId: string, access: ChannelAccess) {
    const channels = await this.accessibleGmailChannels(organizationId, access);
    return {
      connected: channels.length > 0,
      channels: channels.map((c) => {
        const cfg = (c.config as any) || {};
        return {
          id: c.id,
          name: c.name,
          email: (cfg.email as string | undefined) ?? null,
          canSend: this.channelCanSend(c),
          needsReauthForSend: this.channelNeedsReauthForSend(c),
        };
      }),
    };
  }

  private async resolveChannel(
    organizationId: string,
    access: ChannelAccess,
    channelId?: string,
  ): Promise<Channel> {
    if (!channelId) throw new BadRequestException('channelId é obrigatório');
    const channel = await this.prisma.channel.findFirst({
      where: {
        id: channelId,
        organizationId,
        type: ChannelType.GMAIL,
        deletedAt: null,
      },
    });
    if (!channel) throw new NotFoundException('Canal Gmail não encontrado');
    this.channelAccess.assertChannelAccess(access, channel.id);
    return channel;
  }

  /**
   * Detecta se o canal pode enviar.
   * - scope vazio/desconhecido: assume true (tenta enviar; 403 pede reauth)
   * - se scope listado e SEM gmail.send: false
   */
  private channelCanSend(channel: Channel): boolean {
    const scope = String(((channel.config as any) || {}).scope || '');
    if (!scope.trim()) return true;
    return /gmail\.send|gmail\.modify|mail\.google\.com/i.test(scope);
  }

  private channelNeedsReauthForSend(channel: Channel): boolean {
    const scope = String(((channel.config as any) || {}).scope || '');
    if (!scope.trim()) return false;
    return !this.channelCanSend(channel);
  }

  /** Nunca vaza token/erro cru do Google pro cliente — só loga a mensagem. */
  private gmailUnavailable(channel: Channel, err: any, action: string): never {
    this.logger.warn(
      `Gmail ${action} falhou (canal ${channel.id}): ${err?.message ?? err}`,
    );
    throw new BadGatewayException(
      `Falha ao ${action} no Gmail — verifique a conexão do canal`,
    );
  }

  private async labelsFor(channel: Channel): Promise<GmailLabel[]> {
    const cached = this.labelsCache.get(channel.id);
    if (cached && Date.now() - cached.at < LABELS_TTL_MS) return cached.labels;
    try {
      const labels = await this.gmail.listLabels(channel);
      this.labelsCache.set(channel.id, { at: Date.now(), labels });
      return labels;
    } catch (err) {
      this.gmailUnavailable(channel, err, 'listar marcadores');
    }
  }

  async folders(
    organizationId: string,
    access: ChannelAccess,
    channelId?: string,
  ) {
    const channel = await this.resolveChannel(organizationId, access, channelId);
    const labels = await this.labelsFor(channel);
    const userLabels = labels
      .filter((l) => l.type === 'user' && l.id && l.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .slice(0, MAX_USER_LABELS)
      .map<EmailFolder>((l) => ({ id: l.id, name: l.name, kind: 'user' }));
    return {
      channelId: channel.id,
      folders: [...SYSTEM_FOLDERS, ...userLabels],
    };
  }

  private async myEmail(channel: Channel): Promise<string> {
    const cached = this.profileCache.get(channel.id);
    if (cached) return cached;
    const cfgEmail = (channel.config as any)?.email as string | undefined;
    if (cfgEmail) {
      const email = cfgEmail.toLowerCase();
      this.profileCache.set(channel.id, email);
      return email;
    }
    try {
      const profile = await this.gmail.getProfile(channel);
      const email = String(profile.emailAddress || '').toLowerCase();
      this.profileCache.set(channel.id, email);
      return email;
    } catch {
      return '';
    }
  }

  private summarizeThread(
    threadId: string,
    meta: Record<string, any>,
    fallbackSnippet: string,
  ): EmailThreadSummary {
    const messages: any[] = meta?.messages || [];
    const last = messages[messages.length - 1];
    const lastInbound =
      [...messages].reverse().find((m) => !(m.labelIds || []).includes('SENT')) ??
      last;
    const from = extractAddress(headerOf(lastInbound, 'From') || '');
    const subject =
      messages.map((m) => headerOf(m, 'Subject')).find(Boolean) ||
      '(sem assunto)';
    const unread = messages.some((m) => (m.labelIds || []).includes('UNREAD'));
    const internal = last?.internalDate ? Number(last.internalDate) : NaN;
    return {
      id: threadId,
      externalConversationId: threadId,
      subject,
      from,
      snippet: last?.snippet || fallbackSnippet || '',
      date: Number.isNaN(internal) ? null : new Date(internal).toISOString(),
      unread,
    };
  }

  async threads(
    organizationId: string,
    access: ChannelAccess,
    channelId?: string,
    folderId = 'INBOX',
    pageToken?: string,
    limitRaw?: string,
  ) {
    const channel = await this.resolveChannel(organizationId, access, channelId);
    const parsed = Number(limitRaw);
    const limit = Number.isFinite(parsed)
      ? Math.min(Math.max(Math.trunc(parsed), 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    let page: Awaited<ReturnType<GmailHttpClient['listThreads']>>;
    try {
      page = await this.gmail.listThreads(channel, {
        labelIds: [folderId],
        includeSpamTrash: folderId === 'SPAM',
        maxResults: limit,
        pageToken,
      });
    } catch (err) {
      this.gmailUnavailable(channel, err, 'listar e-mails');
    }

    // threads.list só devolve id+snippet — hidrata metadata (headers) por thread.
    const threads = await Promise.all(
      page.threads.map(async (t) => {
        try {
          const meta = await this.gmail.getThreadMetadata(channel, t.id);
          return this.summarizeThread(t.id, meta, t.snippet || '');
        } catch (err: any) {
          this.logger.warn(
            `Gmail thread ${t.id} metadata falhou: ${err?.message ?? err}`,
          );
          return {
            id: t.id,
            externalConversationId: t.id,
            subject: '(sem assunto)',
            from: { email: '' },
            snippet: t.snippet || '',
            date: null,
            unread: false,
          } satisfies EmailThreadSummary;
        }
      }),
    );

    return {
      channelId: channel.id,
      folderId,
      threads,
      nextPageToken: page.nextPageToken ?? null,
    };
  }

  async thread(
    organizationId: string,
    access: ChannelAccess,
    channelId: string | undefined,
    threadId: string,
  ) {
    const channel = await this.resolveChannel(organizationId, access, channelId);
    let full: Record<string, any>;
    try {
      full = await this.gmail.getThread(channel, threadId);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        throw new NotFoundException('E-mail não encontrado');
      }
      this.gmailUnavailable(channel, err, 'carregar o e-mail');
    }

    const my = await this.myEmail(channel);
    const rawMsgs = (full.messages as any[]) || [];
    const allLabels = new Set<string>();
    for (const m of rawMsgs) {
      for (const l of m.labelIds || []) allLabels.add(String(l));
    }
    const messages = rawMsgs.map((m) => {
      const from = extractAddress(headerOf(m, 'From') || '');
      const internal = m.internalDate ? Number(m.internalDate) : NaN;
      return {
        id: String(m.id),
        from,
        to: headerOf(m, 'To'),
        cc: headerOf(m, 'Cc') || '',
        subject: headerOf(m, 'Subject'),
        date: Number.isNaN(internal) ? null : new Date(internal).toISOString(),
        body: extractBody(m),
        snippet: m.snippet || '',
        unread: (m.labelIds || []).includes('UNREAD'),
        outbound: !!my && from.email === my,
        messageId: headerOf(m, 'Message-ID') || headerOf(m, 'Message-Id') || '',
        labelIds: (m.labelIds || []) as string[],
        attachments: extractAttachments(m),
      };
    });

    // Marca como lido ao abrir — AWAIT pra espelhar no Gmail de verdade
    // (fire-and-forget falhava em silêncio e a bolinha na lista não sumia).
    let markedRead = false;
    if (allLabels.has('UNREAD')) {
      try {
        await this.gmail.modifyThreadLabels(channel, threadId, {
          removeLabelIds: ['UNREAD'],
        });
        markedRead = true;
        allLabels.delete('UNREAD');
        for (const m of messages) m.unread = false;
      } catch (err: any) {
        this.logger.warn(
          `Gmail mark-read ${threadId}: ${err?.message || err}`,
        );
      }
    }

    return {
      id: String(full.id || threadId),
      externalConversationId: threadId,
      subject: messages.map((m) => m.subject).find(Boolean) || '(sem assunto)',
      canSend: this.channelCanSend(channel),
      needsReauthForSend: this.channelNeedsReauthForSend(channel),
      myEmail: my || null,
      starred: allLabels.has('STARRED'),
      spam: allLabels.has('SPAM'),
      important: allLabels.has('IMPORTANT'),
      unread: allLabels.has('UNREAD'),
      markedRead,
      labelIds: [...allLabels],
      messages,
    };
  }

  /**
   * Reply no thread Gmail (SPEC-004 W2). Exige scope gmail.send no token do canal.
   */
  async reply(
    organizationId: string,
    access: ChannelAccess,
    input: {
      channelId?: string;
      threadId: string;
      body: string;
      /** Override To (default = From da última mensagem inbound). */
      to?: string;
      /** Cc explícito (vírgula). Em replyAll o servidor monta. */
      cc?: string;
      /** Responder a todos: To=From, Cc=To+Cc originais (sem eu). */
      replyAll?: boolean;
      subject?: string;
    },
  ) {
    const bodyText = (input.body || '').trim();
    if (!bodyText) throw new BadRequestException('Corpo da resposta é obrigatório');
    if (!input.threadId) throw new BadRequestException('threadId é obrigatório');

    const channel = await this.resolveChannel(
      organizationId,
      access,
      input.channelId,
    );
    // Não bloqueia só por string de scope — tenta enviar; 403 vira reauth.
    // (canais legados sem campo scope ficavam presos em loop de reconexão)

    let full: Record<string, any>;
    try {
      full = await this.gmail.getThread(channel, input.threadId);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        throw new NotFoundException('E-mail não encontrado');
      }
      this.gmailUnavailable(channel, err, 'carregar o e-mail para responder');
    }

    const my = (await this.myEmail(channel)).toLowerCase();
    const msgs = (full.messages as any[]) || [];
    if (!msgs.length) throw new BadRequestException('Thread sem mensagens');

    // última inbound (não enviada por nós) para To / In-Reply-To
    let replyToMsg = [...msgs].reverse().find((m) => {
      const from = extractAddress(headerOf(m, 'From') || '');
      return !my || from.email !== my;
    });
    if (!replyToMsg) replyToMsg = msgs[msgs.length - 1];

    const fromAddr = extractAddress(headerOf(replyToMsg, 'From') || '').email;
    let toAddr = (input.to || '').trim() || fromAddr;
    let ccAddr = (input.cc || '').trim();

    if (input.replyAll) {
      // To = From original; Cc = To + Cc do e-mail, sem mim e sem o To
      toAddr = fromAddr;
      const pool = [
        ...extractAddresses(headerOf(replyToMsg, 'To') || ''),
        ...extractAddresses(headerOf(replyToMsg, 'Cc') || ''),
      ];
      const exclude = new Set(
        [my, toAddr].filter(Boolean).map((e) => e.toLowerCase()),
      );
      const ccList = pool
        .map((a) => a.email)
        .filter((e) => e.includes('@') && !exclude.has(e.toLowerCase()));
      // dedupe preserving order
      const seen = new Set<string>();
      ccAddr = ccList
        .filter((e) => {
          const k = e.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .join(', ');
    }

    if (!toAddr || !toAddr.includes('@')) {
      throw new BadRequestException('Destinatário inválido para a resposta');
    }

    const baseSubject =
      input.subject?.trim() ||
      headerOf(replyToMsg, 'Subject') ||
      msgs.map((m) => headerOf(m, 'Subject')).find(Boolean) ||
      '(sem assunto)';
    const subject = /^re\s*:/i.test(baseSubject)
      ? baseSubject
      : `Re: ${baseSubject}`;

    const inReplyTo =
      headerOf(replyToMsg, 'Message-ID') ||
      headerOf(replyToMsg, 'Message-Id') ||
      '';
    const references =
      [headerOf(replyToMsg, 'References'), inReplyTo].filter(Boolean).join(' ').trim();

    const fromHeader = my || String(((channel.config as any) || {}).email || '');
    const raw = this.buildRfc822({
      from: fromHeader,
      to: toAddr,
      cc: ccAddr || undefined,
      subject,
      body: bodyText,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined,
    });

    try {
      const sent = await this.gmail.sendRawMessage(channel, raw, input.threadId);
      return {
        success: true,
        id: sent.id,
        threadId: sent.threadId || input.threadId,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const gmsg = err?.response?.data?.error?.message || err?.message || '';
      if (
        status === 403 ||
        /insufficient|scope|accessNotConfigured|PERMISSION/i.test(String(gmsg))
      ) {
        throw new BadRequestException(
          'Sem permissão de envio no Google. Reconecte o canal Gmail autorizando gmail.send.',
        );
      }
      this.gmailUnavailable(channel, err, 'enviar a resposta');
    }
  }

  /**
   * Compose livre (painel conversa / novo e-mail).
   */
  async compose(
    organizationId: string,
    access: ChannelAccess,
    input: {
      channelId?: string;
      to: string;
      subject: string;
      body: string;
      cc?: string;
    },
  ) {
    const toRaw = (input.to || '').trim();
    const subject = (input.subject || '').trim();
    const bodyText = (input.body || '').trim();
    if (!toRaw.includes('@')) throw new BadRequestException('Destinatário inválido');
    if (!subject) throw new BadRequestException('Assunto é obrigatório');
    if (!bodyText) throw new BadRequestException('Corpo é obrigatório');

    const toList = toRaw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.includes('@'));
    if (!toList.length) throw new BadRequestException('Destinatário inválido');

    const channel = await this.resolveChannel(
      organizationId,
      access,
      input.channelId,
    );
    const my = await this.myEmail(channel);
    const fromHeader = my || String(((channel.config as any) || {}).email || '');
    const raw = this.buildRfc822({
      from: fromHeader,
      to: toList.join(', '),
      cc: (input.cc || '').trim() || undefined,
      subject,
      body: bodyText,
    });

    try {
      const sent = await this.gmail.sendRawMessage(channel, raw);
      return { success: true, id: sent.id, threadId: sent.threadId || '' };
    } catch (err: any) {
      const status = err?.response?.status;
      const gmsg = err?.response?.data?.error?.message || err?.message || '';
      if (
        status === 403 ||
        /insufficient|scope|accessNotConfigured|PERMISSION/i.test(String(gmsg))
      ) {
        throw new BadRequestException(
          'Sem permissão de envio no Google. Reconecte o canal Gmail.',
        );
      }
      this.gmailUnavailable(channel, err, 'enviar o e-mail');
    }
  }

  /** Arquivar thread (remove INBOX). */
  async archive(
    organizationId: string,
    access: ChannelAccess,
    input: { channelId?: string; threadId: string },
  ) {
    return this.modifyLabels(organizationId, access, {
      ...input,
      removeLabelIds: ['INBOX'],
    });
  }

  /**
   * Mutações de label Gmail (star/spam/lido/arquivar/custom).
   * Exige gmail.modify no token.
   */
  async getAttachment(
    organizationId: string,
    access: ChannelAccess,
    input: { channelId?: string; messageId: string; attachmentId: string },
  ) {
    if (!input.messageId || !input.attachmentId) {
      throw new BadRequestException('messageId e attachmentId são obrigatórios');
    }
    const channel = await this.resolveChannel(
      organizationId,
      access,
      input.channelId,
    );
    try {
      const att = await this.gmail.getAttachment(
        channel,
        input.messageId,
        input.attachmentId,
      );
      // Gmail returns base64url
      const b64 = att.data.replace(/-/g, '+').replace(/_/g, '/');
      const buf = Buffer.from(b64, 'base64');
      return { buffer: buf, size: att.size ?? buf.length };
    } catch (err: any) {
      this.gmailUnavailable(channel, err, 'baixar anexo');
    }
  }

    async modifyLabels(
    organizationId: string,
    access: ChannelAccess,
    input: {
      channelId?: string;
      threadId: string;
      addLabelIds?: string[];
      removeLabelIds?: string[];
    },
  ) {
    if (!input.threadId) throw new BadRequestException('threadId é obrigatório');
    const add = (input.addLabelIds || []).map((s) => String(s).trim()).filter(Boolean);
    const remove = (input.removeLabelIds || [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!add.length && !remove.length) {
      throw new BadRequestException('Informe addLabelIds e/ou removeLabelIds');
    }
    const channel = await this.resolveChannel(
      organizationId,
      access,
      input.channelId,
    );
    try {
      const res = await this.gmail.modifyThreadLabels(channel, input.threadId, {
        addLabelIds: add,
        removeLabelIds: remove,
      });
      return {
        success: true,
        threadId: input.threadId,
        labelIds: res.labelIds || [],
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 403) {
        throw new BadRequestException(
          'Sem permissão para alterar o e-mail. Reconecte o Gmail com gmail.modify.',
        );
      }
      this.gmailUnavailable(channel, err, 'alterar marcadores do e-mail');
    }
  }

  /**
   * Encaminha o thread (citação da última mensagem) para novos destinatários.
   */
  async forward(
    organizationId: string,
    access: ChannelAccess,
    input: {
      channelId?: string;
      threadId: string;
      to: string;
      body?: string;
      subject?: string;
    },
  ) {
    const toRaw = (input.to || '').trim();
    if (!toRaw) throw new BadRequestException('Informe o destinatário (To)');
    const toList = toRaw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.includes('@'));
    if (!toList.length) {
      throw new BadRequestException('Destinatário inválido');
    }

    const channel = await this.resolveChannel(
      organizationId,
      access,
      input.channelId,
    );

    let full: Record<string, any>;
    try {
      full = await this.gmail.getThread(channel, input.threadId);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        throw new NotFoundException('E-mail não encontrado');
      }
      this.gmailUnavailable(channel, err, 'carregar o e-mail para encaminhar');
    }

    const my = await this.myEmail(channel);
    const msgs = (full.messages as any[]) || [];
    if (!msgs.length) throw new BadRequestException('Thread sem mensagens');

    const last = msgs[msgs.length - 1];
    const lastFrom = headerOf(last, 'From') || '';
    const lastDate = headerOf(last, 'Date') || '';
    const lastBody = extractBody(last) || last.snippet || '';
    const baseSubject =
      input.subject?.trim() ||
      headerOf(last, 'Subject') ||
      msgs.map((m) => headerOf(m, 'Subject')).find(Boolean) ||
      '(sem assunto)';
    const subject = /^(fwd|enc|fw)\s*:/i.test(baseSubject)
      ? baseSubject
      : `Enc: ${baseSubject}`;

    const userNote = (input.body || '').trim();
    const parts: string[] = [];
    if (userNote) {
      parts.push(userNote, '');
    }
    parts.push(
      '---------- Mensagem encaminhada ----------',
      `De: ${lastFrom}`,
    );
    if (lastDate) parts.push(`Data: ${lastDate}`);
    parts.push(`Assunto: ${baseSubject}`, '', lastBody);

    const fromHeader = my || String(((channel.config as any) || {}).email || '');
    const raw = this.buildRfc822({
      from: fromHeader,
      to: toList.join(', '),
      subject,
      body: parts.join('\n'),
    });

    try {
      const sent = await this.gmail.sendRawMessage(channel, raw);
      return {
        success: true,
        id: sent.id,
        threadId: sent.threadId || '',
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const gmsg = err?.response?.data?.error?.message || err?.message || '';
      if (
        status === 403 ||
        /insufficient|scope|accessNotConfigured|PERMISSION/i.test(String(gmsg))
      ) {
        throw new BadRequestException(
          'Sem permissão de envio no Google. Em Canais use Reconectar Google uma vez e autorize o Gmail.',
        );
      }
      this.gmailUnavailable(channel, err, 'encaminhar o e-mail');
    }
  }

  private buildRfc822(input: {
    from: string;
    to: string;
    cc?: string;
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  }): string {
    const encodeSubject = (s: string) => {
      if (/^[\x20-\x7e]*$/.test(s)) return s;
      return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
    };
    const bodyNorm = input.body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const parts: string[] = [];
    if (input.from) parts.push(`From: ${input.from}`);
    parts.push(`To: ${input.to}`);
    if (input.cc?.trim()) parts.push(`Cc: ${input.cc.trim()}`);
    parts.push(`Subject: ${encodeSubject(input.subject)}`);
    if (input.inReplyTo) parts.push(`In-Reply-To: ${input.inReplyTo}`);
    if (input.references) parts.push(`References: ${input.references}`);
    parts.push('MIME-Version: 1.0');
    parts.push('Content-Type: text/plain; charset=UTF-8');
    parts.push('Content-Transfer-Encoding: 8bit');
    parts.push('');
    parts.push(bodyNorm);
    const rfc = parts.join('\r\n');
    return Buffer.from(rfc, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }
}
