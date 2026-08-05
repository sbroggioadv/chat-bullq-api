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

/** Paleta oficial de colorId de evento do Google (fallback se /colors falhar). */
const GOOGLE_EVENT_COLORS: Record<
  string,
  { background: string; foreground: string }
> = {
  '1': { background: '#a4bdfc', foreground: '#1d1d1d' }, // Lavanda
  '2': { background: '#7ae7bf', foreground: '#1d1d1d' }, // Sálvia
  '3': { background: '#dbadff', foreground: '#1d1d1d' }, // Uva
  '4': { background: '#ff887c', foreground: '#1d1d1d' }, // Flamingo
  '5': { background: '#fbd75b', foreground: '#1d1d1d' }, // Banana
  '6': { background: '#ffb878', foreground: '#1d1d1d' }, // Tangerina
  '7': { background: '#46d6db', foreground: '#1d1d1d' }, // Pavão
  '8': { background: '#e1e1e1', foreground: '#1d1d1d' }, // Grafite
  '9': { background: '#5484ed', foreground: '#1d1d1d' }, // Mirtilo
  '10': { background: '#51b749', foreground: '#1d1d1d' }, // Manjericão
  '11': { background: '#dc2127', foreground: '#ffffff' }, // Tomate
};

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
    return /calendar(\.events|\.readonly)?|calendar\.google\.com/i.test(
      granted,
    );
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
      const [calendars, colorMap] = await Promise.all([
        this.listSelectedCalendars(channel),
        this.getEventColorMap(channel),
      ]);

      // Busca eventos de cada calendário selecionado (cores diferentes no Google)
      const pages = await Promise.all(
        calendars.map(async (cal) => {
          try {
            const { data } = await http.get(
              `/calendars/${encodeURIComponent(cal.id)}/events`,
              {
                params: {
                  timeMin,
                  timeMax,
                  singleEvents: true,
                  orderBy: 'startTime',
                  maxResults: 150,
                },
              },
            );
            return { cal, items: (data.items || []) as any[] };
          } catch (err: any) {
            this.logger.warn(
              `Calendar events ${cal.id}: ${err?.response?.status || err?.message}`,
            );
            return { cal, items: [] as any[] };
          }
        }),
      );

      const items = pages.flatMap(({ cal, items: evs }) =>
        evs.map((ev) => {
          const colorId = ev.colorId != null ? String(ev.colorId) : null;
          const palette =
            (colorId && (colorMap[colorId] || GOOGLE_EVENT_COLORS[colorId])) ||
            null;
          // Prioridade: cor do evento > cor do calendário (como no Google UI)
          const backgroundColor =
            palette?.background || cal.backgroundColor || '#5484ed';
          const foregroundColor =
            palette?.foreground || cal.foregroundColor || '#1d1d1d';
          return {
            id: `${cal.id}:${String(ev.id)}`,
            eventId: String(ev.id),
            calendarId: cal.id,
            calendarSummary: cal.summary,
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
            backgroundColor,
            foregroundColor,
          };
        }),
      );

      // Ordena por início
      items.sort((a, b) => {
        const ta = a.start ? new Date(a.start).getTime() : 0;
        const tb = b.start ? new Date(b.start).getTime() : 0;
        return ta - tb;
      });

      return {
        channelId: channel.id,
        calendarId: 'multi',
        calendars: calendars.map((c) => ({
          id: c.id,
          summary: c.summary,
          backgroundColor: c.backgroundColor,
          foregroundColor: c.foregroundColor,
          primary: c.primary,
        })),
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

  async listCalendars(organizationId: string, access: ChannelAccess, channelId?: string) {
    const channel = await this.resolveGmailChannel(
      organizationId,
      access,
      channelId,
    );
    const calendars = await this.listSelectedCalendars(channel);
    return { channelId: channel.id, calendars };
  }

  async createEvent(
    organizationId: string,
    access: ChannelAccess,
    input: {
      channelId?: string;
      /** Calendário Google de destino (default primary). */
      calendarId?: string;
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
    const calendarId = (input.calendarId || 'primary').trim() || 'primary';
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
        `/calendars/${encodeURIComponent(calendarId)}/events`,
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
        compositeId: `${calendarId}:${String(ev.id)}`,
        calendarId,
        htmlLink: ev.htmlLink || null,
        meetLink,
        start: ev.start?.dateTime || null,
        end: ev.end?.dateTime || null,
        summary: ev.summary,
        note:
          'Meet criado no Google. Gravação/transcrição: ligue no Meet ou via política do Workspace.',
      };
    } catch (err: any) {
      this.throwCalError(err, 'criar evento');
    }
  }

  async updateEvent(
    organizationId: string,
    access: ChannelAccess,
    input: {
      channelId?: string;
      calendarId: string;
      eventId: string;
      summary?: string;
      description?: string;
      startIso?: string;
      endIso?: string;
      attendeeEmails?: string[];
      withMeet?: boolean;
      timeZone?: string;
    },
  ) {
    const calendarId = (input.calendarId || '').trim();
    const eventId = (input.eventId || '').trim();
    if (!calendarId || !eventId) {
      throw new BadRequestException('calendarId e eventId são obrigatórios');
    }
    const channel = await this.resolveGmailChannel(
      organizationId,
      access,
      input.channelId,
    );
    const tz = input.timeZone || DEFAULT_TZ;

    try {
      const http = await this.calClient(channel);
      // PATCH parcial — só campos enviados
      const body: Record<string, any> = {};
      if (input.summary !== undefined) body.summary = input.summary.trim();
      if (input.description !== undefined) body.description = input.description;
      if (input.startIso) body.start = { dateTime: input.startIso, timeZone: tz };
      if (input.endIso) body.end = { dateTime: input.endIso, timeZone: tz };
      if (input.attendeeEmails) {
        body.attendees = input.attendeeEmails
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e.includes('@'))
          .map((email) => ({ email }));
      }
      if (input.withMeet === true) {
        body.conferenceData = {
          createRequest: {
            requestId: randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        };
      }

      const { data: ev } = await http.patch(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        body,
        {
          params: {
            conferenceDataVersion: input.withMeet === true ? 1 : 0,
            sendUpdates: 'all',
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
        compositeId: `${calendarId}:${String(ev.id)}`,
        calendarId,
        htmlLink: ev.htmlLink || null,
        meetLink,
        start: ev.start?.dateTime || null,
        end: ev.end?.dateTime || null,
        summary: ev.summary,
      };
    } catch (err: any) {
      this.throwCalError(err, 'atualizar evento');
    }
  }

  async deleteEvent(
    organizationId: string,
    access: ChannelAccess,
    input: {
      channelId?: string;
      calendarId: string;
      eventId: string;
      /** Notifica convidados (default true). */
      notify?: boolean;
    },
  ) {
    const calendarId = (input.calendarId || '').trim();
    const eventId = (input.eventId || '').trim();
    if (!calendarId || !eventId) {
      throw new BadRequestException('calendarId e eventId são obrigatórios');
    }
    const channel = await this.resolveGmailChannel(
      organizationId,
      access,
      input.channelId,
    );
    try {
      const http = await this.calClient(channel);
      await http.delete(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        {
          params: {
            sendUpdates: input.notify === false ? 'none' : 'all',
          },
        },
      );
      return { success: true, calendarId, eventId };
    } catch (err: any) {
      this.throwCalError(err, 'apagar evento');
    }
  }

  private throwCalError(err: any, action: string): never {
    const status = err?.response?.status;
    const gmsg = err?.response?.data?.error?.message || err?.message || '';
    this.logger.warn(`Calendar ${action}: ${status} ${gmsg}`);
    if (status === 404) {
      throw new NotFoundException('Evento não encontrado no Google');
    }
    if (status === 403 || /insufficient|scope/i.test(String(gmsg))) {
      throw new BadRequestException(
        'Sem permissão de Agenda. Em Canais use Autorizar Agenda.',
      );
    }
    throw new BadGatewayException(`Falha ao ${action} no Google Calendar`);
  }

  /** Paleta colorId de evento (API /colors + fallback oficial). */
  private async getEventColorMap(
    channel: Channel,
  ): Promise<Record<string, { background: string; foreground: string }>> {
    const cached = this.colorsCache.get(channel.id);
    if (cached && Date.now() - cached.at < 6 * 60 * 60_000) {
      return { ...GOOGLE_EVENT_COLORS, ...cached.event };
    }
    try {
      const http = await this.calClient(channel);
      const { data } = await http.get('/colors');
      const event: Record<string, { background: string; foreground: string }> =
        { ...GOOGLE_EVENT_COLORS };
      for (const [id, val] of Object.entries(
        (data.event || {}) as Record<string, any>,
      )) {
        event[id] = {
          background: String(val.background || event[id]?.background || '#5484ed'),
          foreground: String(val.foreground || event[id]?.foreground || '#1d1d1d'),
        };
      }
      this.colorsCache.set(channel.id, { at: Date.now(), event });
      return event;
    } catch (err: any) {
      this.logger.warn(`Calendar colors: ${err?.message || err}`);
      return { ...GOOGLE_EVENT_COLORS, ...(cached?.event || {}) };
    }
  }

  /**
   * Calendários marcados como visíveis no Google (selected).
   * Cada um traz backgroundColor — é o que pinta a UI multi-cor.
   */
  private async listSelectedCalendars(channel: Channel): Promise<
    Array<{
      id: string;
      summary: string;
      backgroundColor: string;
      foregroundColor: string;
      primary: boolean;
    }>
  > {
    const http = await this.calClient(channel);
    try {
      const { data } = await http.get('/users/me/calendarList', {
        params: { minAccessRole: 'reader', maxResults: 50 },
      });
      const items = (data.items || []) as any[];
      const selected = items
        .filter((c) => c.selected !== false && c.id)
        .map((c) => ({
          id: String(c.id),
          summary: String(c.summary || c.id),
          backgroundColor: String(c.backgroundColor || '#5484ed'),
          foregroundColor: String(c.foregroundColor || '#1d1d1d'),
          primary: !!c.primary,
        }));
      if (selected.length) return selected;
    } catch (err: any) {
      this.logger.warn(
        `calendarList failed (precisa calendar.readonly): ${err?.response?.status || err?.message}`,
      );
    }
    // Fallback: só primary
    return [
      {
        id: 'primary',
        summary: 'Principal',
        backgroundColor: '#039be5',
        foregroundColor: '#ffffff',
        primary: true,
      },
    ];
  }
}
