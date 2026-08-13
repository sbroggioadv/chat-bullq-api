import { Injectable } from '@nestjs/common';
import { ChannelType, ConversationStatus, MessageDirection } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { WatchdogConfigService } from '../routing/watchdog/watchdog-config.service';
import { EmailService } from '../email/email.service';
import { CalendarService } from '../calendar/calendar.service';
import type { LlmToolDefinition } from '../ai-agents/llm/llm.types';

const CUSTOMER_CHANNELS: ChannelType[] = [
  ChannelType.WHATSAPP_ZAPPFY,
  ChannelType.WHATSAPP_OFFICIAL,
  ChannelType.INSTAGRAM,
  ChannelType.GMAIL,
];

export const JARVIS_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'inbox_overview',
    description:
      'Snapshot atual do inbox de atendimento (exclui o próprio canal Jarvis): abertas, pendentes, esperando, bot, presas, mensagens nas últimas 24h.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_conversations',
    description:
      'Lista conversas de atendimento. Filtros: status (OPEN|PENDING|WAITING|BOT|CLOSED), stuck (presas no watchdog), unansweredMinutes (última msg do cliente sem resposta do time).',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['OPEN', 'PENDING', 'WAITING', 'BOT', 'CLOSED'],
        },
        stuck: { type: 'boolean' },
        unansweredMinutes: { type: 'number' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_conversation',
    description:
      'Detalhe de uma conversa de atendimento: status, contato, canal, agente, últimas mensagens (texto).',
    parameters: {
      type: 'object',
      properties: { conversationId: { type: 'string' } },
      required: ['conversationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'watchdog_status',
    description:
      'Como está o monitoramento automático (watchdog): ligado/desligado, conversas presas, config de atrasos.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_emails',
    description:
      'Lista threads do Gmail conectado no BullQ (caixa de entrada por padrão). Pastas: INBOX, SENT, SPAM, STARRED ou um label. Não envia e-mail.',
    parameters: {
      type: 'object',
      properties: {
        folderId: { type: 'string' },
        unreadOnly: { type: 'boolean' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_email',
    description:
      'Abre um thread do Gmail pelo id devolvido em list_emails. Traz remetente, assunto e corpo texto. Não responde o e-mail.',
    parameters: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_calendar_events',
    description:
      'Lista compromissos da agenda Google ligada ao Gmail do BullQ. Passe from/to em ISO. Default: ontem até +14 dias. Não cria evento.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

@Injectable()
export class JarvisDeskTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly watchdogConfig: WatchdogConfigService,
    private readonly email: EmailService,
    private readonly calendar: CalendarService,
  ) {}

  async execute(
    organizationId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case 'inbox_overview':
        return this.inboxOverview(organizationId);
      case 'list_conversations':
        return this.listConversations(organizationId, args);
      case 'get_conversation':
        return this.getConversation(organizationId, String(args.conversationId ?? ''));
      case 'watchdog_status':
        return this.watchdogStatus(organizationId);
      case 'list_emails':
        return this.listEmails(organizationId, args);
      case 'get_email':
        return this.getEmail(organizationId, String(args.threadId ?? ''));
      case 'list_calendar_events':
        return this.listCalendarEvents(organizationId, args);
      default:
        return { error: `tool desconhecida: ${name}` };
    }
  }

  async inboxOverview(organizationId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const customer = {
      organizationId,
      deletedAt: null,
      channel: { type: { in: CUSTOMER_CHANNELS } },
    };

    const [open, pending, waiting, bot, stuck, closed24h, inbound24h, outbound24h] =
      await this.prisma.$transaction([
        this.prisma.conversation.count({
          where: { ...customer, status: ConversationStatus.OPEN },
        }),
        this.prisma.conversation.count({
          where: { ...customer, status: ConversationStatus.PENDING },
        }),
        this.prisma.conversation.count({
          where: { ...customer, status: ConversationStatus.WAITING },
        }),
        this.prisma.conversation.count({
          where: { ...customer, status: ConversationStatus.BOT },
        }),
        this.prisma.conversation.count({
          where: { ...customer, isStuck: true },
        }),
        this.prisma.conversation.count({
          where: {
            ...customer,
            status: ConversationStatus.CLOSED,
            closedAt: { gte: since },
          },
        }),
        this.prisma.message.count({
          where: {
            direction: MessageDirection.INBOUND,
            createdAt: { gte: since },
            conversation: customer,
          },
        }),
        this.prisma.message.count({
          where: {
            direction: MessageDirection.OUTBOUND,
            createdAt: { gte: since },
            conversation: customer,
          },
        }),
      ]);

    return {
      window: '24h',
      open,
      pending,
      waiting,
      bot,
      stuck,
      closed24h,
      inbound24h,
      outbound24h,
    };
  }

  async listConversations(organizationId: string, args: Record<string, unknown>) {
    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 40);
    const status = typeof args.status === 'string' ? (args.status as ConversationStatus) : undefined;
    const stuck = args.stuck === true;
    const unansweredMinutes =
      typeof args.unansweredMinutes === 'number' && args.unansweredMinutes > 0
        ? args.unansweredMinutes
        : undefined;

    const rows = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        deletedAt: null,
        channel: { type: { in: CUSTOMER_CHANNELS } },
        ...(status ? { status } : {}),
        ...(stuck ? { isStuck: true } : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: unansweredMinutes ? 80 : limit,
      select: {
        id: true,
        status: true,
        protocol: true,
        isStuck: true,
        lastMessageAt: true,
        assignedTo: { select: { name: true } },
        activeAgent: { select: { name: true } },
        contact: { select: { name: true, phone: true } },
        channel: { select: { name: true, type: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { direction: true, createdAt: true, type: true, content: true },
        },
      },
    });

    const mapped = rows.map((row) => {
      const last = row.messages[0];
      return {
        conversationId: row.id,
        protocol: row.protocol,
        status: row.status,
        stuck: row.isStuck,
        contact: row.contact.name ?? row.contact.phone ?? 'sem nome',
        channel: row.channel.name,
        channelType: row.channel.type,
        assignee: row.assignedTo?.name ?? null,
        agent: row.activeAgent?.name ?? null,
        lastMessageAt: row.lastMessageAt,
        lastDirection: last?.direction ?? null,
        lastPreview: previewText(last?.content),
      };
    });

    if (!unansweredMinutes) return mapped.slice(0, limit);

    const cutoff = Date.now() - unansweredMinutes * 60_000;
    return mapped
      .filter(
        (row) =>
          row.lastDirection === MessageDirection.INBOUND &&
          row.lastMessageAt &&
          row.lastMessageAt.getTime() < cutoff,
      )
      .slice(0, limit);
  }

  async getConversation(organizationId: string, conversationId: string) {
    if (!conversationId) return { error: 'conversationId obrigatório' };
    const conv = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        organizationId,
        deletedAt: null,
        channel: { type: { in: CUSTOMER_CHANNELS } },
      },
      select: {
        id: true,
        status: true,
        protocol: true,
        isStuck: true,
        aiEnabled: true,
        lastMessageAt: true,
        assignedTo: { select: { name: true } },
        activeAgent: { select: { name: true } },
        contact: { select: { name: true, phone: true, email: true } },
        channel: { select: { name: true, type: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 12,
          select: { direction: true, createdAt: true, type: true, content: true },
        },
      },
    });
    if (!conv) return { error: 'conversa não encontrada no inbox de atendimento' };
    return {
      conversationId: conv.id,
      protocol: conv.protocol,
      status: conv.status,
      stuck: conv.isStuck,
      aiEnabled: conv.aiEnabled,
      contact: conv.contact,
      channel: conv.channel,
      assignee: conv.assignedTo?.name ?? null,
      agent: conv.activeAgent?.name ?? null,
      lastMessageAt: conv.lastMessageAt,
      recentMessages: conv.messages
        .slice()
        .reverse()
        .map((m) => ({
          direction: m.direction,
          at: m.createdAt,
          preview: previewText(m.content),
        })),
    };
  }

  async watchdogStatus(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        watchdogEnabled: true,
        watchdogConfig: true,
        aiEnabled: true,
        aiPanicMode: true,
      },
    });
    if (!org) return { error: 'organização não encontrada' };
    const cfg = this.watchdogConfig.resolve(org);
    const stuck = await this.prisma.conversation.count({
      where: {
        organizationId,
        deletedAt: null,
        isStuck: true,
        channel: { type: { in: CUSTOMER_CHANNELS } },
      },
    });
    return {
      watchdogEnabled: org.watchdogEnabled,
      aiEnabled: org.aiEnabled,
      panicMode: org.aiPanicMode,
      stuckConversations: stuck,
      delaysMinutes: {
        bot: cfg.delayBotMin,
        pending: cfg.delayPendingMin,
        humanIdle: cfg.delayHumanIdleMin,
        maxAttempts: cfg.maxAttempts,
      },
    };
  }

  async listEmails(organizationId: string, args: Record<string, unknown>) {
    const channelId = await this.firstGmailChannelId(organizationId);
    if (!channelId) {
      return {
        error:
          'Nenhum Gmail conectado nesta organização. Conecte em Configurações → Canais.',
      };
    }
    const folderId =
      typeof args.folderId === 'string' && args.folderId.trim()
        ? args.folderId.trim()
        : 'INBOX';
    const limit = String(Math.min(Math.max(Number(args.limit) || 12, 1), 25));
    try {
      const page = await this.email.threads(
        organizationId,
        'ALL',
        channelId,
        folderId,
        undefined,
        limit,
      );
      const threads = (page.threads ?? []).filter((t) =>
        args.unreadOnly === true ? t.unread : true,
      );
      return {
        channelId: page.channelId,
        folderId: page.folderId,
        threads: threads.map((t) => ({
          threadId: t.id,
          subject: t.subject,
          from: t.from,
          snippet: (t.snippet || '').slice(0, 220),
          date: t.date,
          unread: t.unread,
        })),
      };
    } catch (err) {
      return { error: (err as Error).message || 'Falha ao listar e-mails' };
    }
  }

  async getEmail(organizationId: string, threadId: string) {
    if (!threadId) return { error: 'threadId obrigatório' };
    const channelId = await this.firstGmailChannelId(organizationId);
    if (!channelId) {
      return {
        error:
          'Nenhum Gmail conectado nesta organização. Conecte em Configurações → Canais.',
      };
    }
    try {
      const full = await this.email.thread(
        organizationId,
        'ALL',
        channelId,
        threadId,
      );
      return {
        threadId: full.id,
        subject: full.subject,
        unread: full.unread,
        messages: (full.messages ?? []).slice(-6).map((m) => ({
          from: m.from,
          to: m.to,
          date: m.date,
          outbound: m.outbound,
          body: String(m.body || m.snippet || '').slice(0, 1500),
        })),
      };
    } catch (err) {
      return { error: (err as Error).message || 'Falha ao abrir o e-mail' };
    }
  }

  async listCalendarEvents(organizationId: string, args: Record<string, unknown>) {
    const from = typeof args.from === 'string' ? args.from : undefined;
    const to = typeof args.to === 'string' ? args.to : undefined;
    try {
      const page = await this.calendar.listEvents(organizationId, 'ALL', {
        from,
        to,
      });
      return {
        channelId: page.channelId,
        from: page.timeMin,
        to: page.timeMax,
        calendars: (page.calendars ?? []).map((c) => c.summary),
        events: (page.events ?? []).slice(0, 25).map((ev) => ({
          eventId: ev.eventId,
          title: ev.summary,
          start: ev.start,
          end: ev.end,
          allDay: ev.allDay,
          calendar: ev.calendarSummary,
          meet: ev.meetLink,
          attendees: (ev.attendees ?? [])
            .slice(0, 8)
            .map((a: { displayName?: string; email?: string }) => a.displayName || a.email),
        })),
      };
    } catch (err) {
      return {
        error:
          (err as Error).message ||
          'Falha ao listar a agenda. Reconecte o Google em Canais e autorize o Calendar.',
      };
    }
  }

  private async firstGmailChannelId(organizationId: string): Promise<string | null> {
    const status = await this.email.status(organizationId, 'ALL');
    return status.channels[0]?.id ?? null;
  }
}

function previewText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  if (typeof c.text === 'string') return c.text.slice(0, 180);
  if (typeof c.caption === 'string') return c.caption.slice(0, 180);
  return '';
}
