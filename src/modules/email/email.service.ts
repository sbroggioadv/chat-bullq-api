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
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        email: ((c.config as any)?.email as string | undefined) ?? null,
      })),
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
    const messages = ((full.messages as any[]) || []).map((m) => {
      const from = extractAddress(headerOf(m, 'From') || '');
      const internal = m.internalDate ? Number(m.internalDate) : NaN;
      return {
        id: String(m.id),
        from,
        to: headerOf(m, 'To'),
        subject: headerOf(m, 'Subject'),
        date: Number.isNaN(internal) ? null : new Date(internal).toISOString(),
        body: extractBody(m),
        snippet: m.snippet || '',
        unread: (m.labelIds || []).includes('UNREAD'),
        outbound: !!my && from.email === my,
      };
    });

    return {
      id: String(full.id || threadId),
      externalConversationId: threadId,
      subject: messages.map((m) => m.subject).find(Boolean) || '(sem assunto)',
      messages,
    };
  }
}
