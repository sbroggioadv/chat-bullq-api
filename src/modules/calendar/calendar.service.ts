import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import {
  ChannelAccess,
  ChannelAccessService,
} from '../iam/channel-access/channel-access.service';
import { GmailHttpClient } from '../channel-hub/adapters/gmail/gmail.http-client';

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const DEFAULT_TZ = 'America/Sao_Paulo';

/**
 * Agenda produto (ADR-004 W3) — usa o refresh token do canal Gmail da org
 * (mesmo Google Connect). Nunca usa SOFIA_CALENDAR_ID / refresh global.
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);
  /** Cache de cores do Google (event colorId → bg/fg). */
  private colorsCache = new Map<
    string,
    { at: number; event: Record<string, { background: string; foreground: string }> }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessService,
    private readonly gmail: GmailHttpClient,
  ) {}

  private async resolveGmailChannel(
    organizationId: string,
    access: ChannelAccess,
    channelId?: string,
  ): Promise<Channel> {
    if (channelId) {
      const ch = await this.prisma.channel.findFirst({
        where: {
          id: channelId,
          organizationId,
          type: ChannelType.GMAIL,
          deletedAt: null,
        },
      });
      if (!ch) throw new NotFoundException('Canal Gmail não encontrado');
      this.channelAccess.assertChannelAccess(access, ch.id);
      return ch;
    }
    const channels = await this.prisma.channel.findMany({
      where: {
        organizationId,
        type: ChannelType.GMAIL,
        deletedAt: null,
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const allowed = channels.filter((c) =>
      this.channelAccess.hasAccess(access, c.id),
    );
    if (!allowed.length) {
      throw new BadRequestException(
        'Nenhum canal Gmail conectado — conecte o Google em Canais',
      );
    }
    return allowed[0];
  }

  private channelHasCalendar(channel: Channel): boolean {
    const cfg = ((channel.config as any) || {}) as Record<string, any>;
    if (typeof cfg.hasCalendar === 'boolean') return cfg.hasCalendar;
    // Fonte da verdade: o que o Google concedeu no último consent
    const granted = String(cfg.scopeGranted || cfg.scope || '');
    if (!granted.trim()) return false; // desconhecido → pede Autorizar Agenda
    return /calendar(\.events)?|calendar\.google\.com/i.test(granted);
  }

  async status(organizationId: string, access: ChannelAccess) {
    const channels = await this.prisma.channel.findMany({
      where: {
        organizationId,
        type: ChannelType.GMAIL,
        deletedAt: null,
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const allowed = channels.filter((c) =>
      this.channelAccess.hasAccess(access, c.id),
    );
    const primary = allowed[0];
    const cfg = ((primary?.config as any) || {}) as Record<string, any>;
    const granted = String(cfg.scopeGranted || cfg.scope || '');
    const hasCal = primary ? this.channelHasCalendar(primary) : false;
    return {
      connected: !!primary,
      calendarAuthorized: hasCal,
      channelId: primary?.id || null,
      email: cfg.email || null,
      scopes: granted ? granted.split(/\s+/).filter(Boolean) : [],
      needsReauthForCalendar: !!primary && !hasCal,
      note: 'Agenda usa o mesmo Google Connect do canal Gmail (Canais → Autorizar Agenda).',
    };
  }

  private async calClient(channel: Channel) {
    const token = await this.gmail.accessToken(channel);
    return axios.create({
      baseURL: 'https://www.googleapis.com/calendar/v3',
      timeout: 20_000,
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async listEvents(
    organizationId: string,
    access: ChannelAccess,
    opts: { channelId?: string; from?: string; to?: string },
  ) {
    const channel = await this.resolveGmailChannel(
      organizationId,
      access,
      opts.channelId,
    );
    const now = new Date();
    const timeMin = opts.from
      ? new Date(opts.from).toISOString()
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
    const timeMax = opts.to
      ? new Date(opts.to).toISOString()
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14).toISOString();

    try {
      const http = await this.calClient(channel);
      const [eventsResp, colorMap, calMeta] = await Promise.all([
        http.get('/calendars/primary/events', {
          params: {
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 250,
          },
        }),
        this.getEventColorMap(channel),
        this.getPrimaryCalendarMeta(channel).catch(() => null),
      ]);
      const data = eventsResp.data;
      const defaultBg = calMeta?.backgroundColor || '#3b82f6';
      const defaultFg = calMeta?.foregroundColor || '#ffffff';
      const items = (data.items || []).map((ev: any) => {
        const colorId = ev.colorId ? String(ev.colorId) : null;
        const palette = (colorId && colorMap[colorId]) || null;
        return {
          id: String(ev.id),
          summary: ev.summary || '(sem título)',
          description: ev.description || '',
          htmlLink: ev.htmlLink || null,
          meetLink:
            ev.hangoutLink ||
            ev.conferenceData?.entryPoints?.find(
              (e: any) => e.entryPointType === 'video',
            )?.uri ||
            null,
          start: ev.start?.dateTime || ev.start?.date || null,
          end: ev.end?.dateTime || ev.end?.date || null,
          allDay: !!ev.start?.date && !ev.start?.dateTime,
          attendees: (ev.attendees || []).map((a: any) => ({
            email: a.email,
            displayName: a.displayName,
            responseStatus: a.responseStatus,
          })),
          status: ev.status,
          colorId,
          backgroundColor: palette?.background || defaultBg,
          foregroundColor: palette?.foreground || defaultFg,
        };
      });
      return {
        channelId: channel.id,
        calendarId: 'primary',
        timeMin,
        timeMax,
        events: items,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const gmsg = err?.response?.data?.error?.message || err?.message || '';
      this.logger.warn(`Calendar listEvents: ${status} ${gmsg}`);
      if (status === 403 || /insufficient|scope/i.test(String(gmsg))) {
        throw new BadRequestException(
          'Sem permissão de Agenda. Em Canais use Reconectar Google e autorize o Calendar.',
        );
      }
      throw new BadGatewayException('Falha ao listar eventos do Google Calendar');
    }
  }

  async createEvent(
    organizationId: string,
    access: ChannelAccess,
    input: {
      channelId?: string;
      summary: string;
      description?: string;
      startIso: string;
      endIso: string;
      attendeeEmails?: string[];
      withMeet?: boolean;
      timeZone?: string;
    },
  ) {
    const summary = (input.summary || '').trim();
    if (!summary) throw new BadRequestException('Título é obrigatório');
    if (!input.startIso || !input.endIso) {
      throw new BadRequestException('Início e fim são obrigatórios');
    }
    const channel = await this.resolveGmailChannel(
      organizationId,
      access,
      input.channelId,
    );
    const tz = input.timeZone || DEFAULT_TZ;
    const attendees = (input.attendeeEmails || [])
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@'))
      .map((email) => ({ email }));

    const body: Record<string, any> = {
      summary,
      description: input.description || undefined,
      start: { dateTime: input.startIso, timeZone: tz },
      end: { dateTime: input.endIso, timeZone: tz },
      attendees: attendees.length ? attendees : undefined,
    };
    if (input.withMeet !== false) {
      body.conferenceData = {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    try {
      const http = await this.calClient(channel);
      const { data: ev } = await http.post(
        '/calendars/primary/events',
        body,
        {
          params: {
            conferenceDataVersion: input.withMeet === false ? 0 : 1,
            sendUpdates: attendees.length ? 'all' : 'none',
          },
        },
      );
      const meetLink =
        ev.hangoutLink ||
        ev.conferenceData?.entryPoints?.find(
          (e: any) => e.entryPointType === 'video',
        )?.uri ||
        null;
      return {
        success: true,
        id: String(ev.id),
        htmlLink: ev.htmlLink || null,
        meetLink,
        start: ev.start?.dateTime || null,
        end: ev.end?.dateTime || null,
        summary: ev.summary,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const gmsg = err?.response?.data?.error?.message || err?.message || '';
      this.logger.warn(`Calendar createEvent: ${status} ${gmsg}`);
      if (status === 403 || /insufficient|scope/i.test(String(gmsg))) {
        throw new BadRequestException(
          'Sem permissão de Agenda. Reconecte o Google autorizando o Calendar.',
        );
      }
      throw new BadGatewayException('Falha ao criar evento no Google Calendar');
    }
  }

  /** Paleta oficial de cores de evento do Google Calendar. */
  private async getEventColorMap(
    channel: Channel,
  ): Promise<Record<string, { background: string; foreground: string }>> {
    const cached = this.colorsCache.get(channel.id);
    if (cached && Date.now() - cached.at < 6 * 60 * 60_000) return cached.event;
    try {
      const http = await this.calClient(channel);
      const { data } = await http.get('/colors');
      const event: Record<string, { background: string; foreground: string }> =
        {};
      for (const [id, val] of Object.entries((data.event || {}) as Record<string, any>)) {
        event[id] = {
          background: String(val.background || '#3b82f6'),
          foreground: String(val.foreground || '#ffffff'),
        };
      }
      this.colorsCache.set(channel.id, { at: Date.now(), event });
      return event;
    } catch (err: any) {
      this.logger.warn(`Calendar colors: ${err?.message || err}`);
      return cached?.event || {};
    }
  }

  /** Cor padrão do calendário primary (quando o evento não tem colorId). */
  private async getPrimaryCalendarMeta(channel: Channel): Promise<{
    backgroundColor?: string;
    foregroundColor?: string;
  } | null> {
    const http = await this.calClient(channel);
    try {
      const { data } = await http.get('/calendars/primary');
      return {
        backgroundColor: data.backgroundColor,
        foregroundColor: data.foregroundColor,
      };
    } catch {
      // calendarList entry às vezes tem a cor
      const { data } = await http.get('/users/me/calendarList/primary');
      return {
        backgroundColor: data.backgroundColor,
        foregroundColor: data.foregroundColor,
      };
    }
  }
}
