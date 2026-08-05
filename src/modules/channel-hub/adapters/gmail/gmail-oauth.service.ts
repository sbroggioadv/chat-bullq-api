import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelType, OrgRole } from '@prisma/client';
import axios from 'axios';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../../../database/prisma.service';
import { ChannelsService } from '../../channels/channels.service';

export interface GmailOAuthStartInput {
  organizationId: string;
  userOrganizationId: string;
  role: OrgRole;
  name?: string;
  visibility?: 'ORG' | 'PRIVATE';
  /** Se informado, reconecta ESTE canal (não cria outro). */
  channelId?: string;
}

interface OAuthStatePayload {
  v: 1;
  orgId: string;
  uoId: string;
  role: OrgRole;
  name: string;
  visibility: 'ORG' | 'PRIVATE';
  channelId?: string;
  nonce: string;
  exp: number;
}

const GMAIL_SCOPES = [
  // modify cobre leitura + envio + labels (necessário p/ reply estável)
  'https://www.googleapis.com/auth/gmail.modify',
  // Agenda do produto (W3) — mesmo Google Connect progressivo da org
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ');

/**
 * Conector Gmail multi-tenant.
 *
 * - Client ID/Secret = credenciais da **plataforma** (env) — um app Google Cloud.
 * - Refresh token = **por canal/org** (gravado em channel.config) — nunca compartilhado.
 * - State assinado HMAC com TTL curto (evita CSRF + garante isolamento de tenant).
 */
@Injectable()
export class GmailOAuthService {
  private readonly logger = new Logger(GmailOAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly channelsService: ChannelsService,
    private readonly prisma: PrismaService,
  ) {}

  isConfigured(): boolean {
    return !!(this.clientId() && this.clientSecret() && this.stateSecret());
  }

  private clientId(): string {
    return (
      this.config.get<string>('GMAIL_OAUTH_CLIENT_ID') ||
      this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID') ||
      ''
    );
  }

  private clientSecret(): string {
    return (
      this.config.get<string>('GMAIL_OAUTH_CLIENT_SECRET') ||
      this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET') ||
      ''
    );
  }

  private stateSecret(): string {
    return (
      this.config.get<string>('GMAIL_OAUTH_STATE_SECRET') ||
      this.config.get<string>('JWT_SECRET') ||
      ''
    );
  }

  /** URL pública da API (callback). */
  redirectUri(): string {
    const appUrl = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    if (!appUrl) {
      throw new ServiceUnavailableException('APP_URL não configurada — necessária pro callback OAuth Gmail');
    }
    return `${appUrl}/api/v1/channels/gmail/oauth/callback`;
  }

  webChannelsUrl(): string {
    const web =
      this.config.get<string>('WEB_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('CORS_ORIGIN')?.split(',')[0]?.trim() ||
      'https://bullq.iacombativa.com';
    return `${web.replace(/\/$/, '')}/settings/channels`;
  }

  status() {
    return {
      configured: this.isConfigured(),
      redirectUri: this.isConfigured() ? this.redirectUri() : null,
      scopes: GMAIL_SCOPES.split(' '),
      multiTenant: true,
      note:
        'Cada organização conecta a própria conta Google. O refresh token fica só no canal da org.',
    };
  }

  start(input: GmailOAuthStartInput): { url: string; expiresInSec: number } {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Conector Gmail não configurado no servidor (GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET)',
      );
    }

    const expiresInSec = 600;
    const state = this.signState({
      v: 1,
      orgId: input.organizationId,
      uoId: input.userOrganizationId,
      role: input.role,
      name: (input.name || '').trim() || 'Gmail',
      visibility: input.visibility || 'PRIVATE',
      channelId: input.channelId || undefined,
      nonce: randomBytes(12).toString('hex'),
      exp: Math.floor(Date.now() / 1000) + expiresInSec,
    });

    const params = new URLSearchParams({
      client_id: this.clientId(),
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: GMAIL_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });

    return {
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      expiresInSec,
    };
  }

  /**
   * Callback do Google.
   * - Reconecta canal existente (mesmo e-mail na org ou channelId no state).
   * - Só cria canal NOVO se não houver match.
   * - Nunca multiplica caixas a cada "Reconectar".
   */
  async handleCallback(code?: string, state?: string, oauthError?: string): Promise<string> {
    const base = this.webChannelsUrl();
    if (oauthError) {
      return `${base}?gmail=error&reason=${encodeURIComponent(oauthError)}`;
    }
    if (!code || !state) {
      return `${base}?gmail=error&reason=${encodeURIComponent('missing_code_or_state')}`;
    }

    let payload: OAuthStatePayload;
    try {
      payload = this.verifyState(state);
    } catch (err: any) {
      this.logger.warn(`Gmail OAuth state invalid: ${err.message}`);
      return `${base}?gmail=error&reason=${encodeURIComponent('invalid_state')}`;
    }

    try {
      const tokens = await this.exchangeCode(code);
      const email = (await this.fetchEmail(tokens.access_token)).toLowerCase();
      // Sempre persiste os scopes PEDIDOS (inclui gmail.send). O token devolvido
      // pelo Google após prompt=consent passa a valer para esses scopes; se
      // salvarmos só tokens.scope parcial, a UI fica em loop de "reconectar".
      const scope = [GMAIL_SCOPES, tokens.scope || ''].filter(Boolean).join(' ');

      // All active Gmail channels in this org
      const candidates = await this.prisma.channel.findMany({
        where: {
          organizationId: payload.orgId,
          type: ChannelType.GMAIL,
          deletedAt: null,
        },
        orderBy: { createdAt: 'asc' },
      });

      // 1) canal explícito no state (reconnect do card / reply CTA)
      let existing =
        (payload.channelId
          ? candidates.find((c) => c.id === payload.channelId)
          : undefined) || null;

      // 2) mesmo e-mail na org
      if (!existing && email) {
        existing =
          candidates.find((c) => {
            const cfg = (c.config as any) || {};
            return String(cfg.email || '').toLowerCase() === email;
          }) || null;
      }

      // 3) ANY existing Gmail channel → update oldest, retire the rest.
      //    Heals "3x GMAIL - LUIS" duplicates from earlier reconnect bugs.
      if (!existing && candidates.length > 0) {
        existing = candidates[0];
      }

      if (existing) {
        const prev = ((existing.config as any) || {}) as Record<string, any>;
        const refreshToken = tokens.refresh_token || prev.refreshToken;
        if (!refreshToken) {
          return `${base}?gmail=error&reason=${encodeURIComponent('no_refresh_token')}`;
        }
        await this.prisma.channel.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            config: {
              ...prev,
              email: email || prev.email,
              refreshToken,
              // grava scopes pedidos/retornados — habilita canSend sem novo canal
              scope,
              connectedAt: new Date().toISOString(),
              auth: 'oauth_platform_app',
              lastReconnectAt: new Date().toISOString(),
            },
          },
        });
        // Retire every other Gmail channel in this org (same Google account)
        const siblings = await this.prisma.channel.findMany({
          where: {
            organizationId: payload.orgId,
            type: ChannelType.GMAIL,
            deletedAt: null,
            id: { not: existing.id },
          },
        });
        for (const c of siblings) {
          await this.prisma.channel.update({
            where: { id: c.id },
            data: { deletedAt: new Date(), isActive: false },
          });
          this.logger.warn(
            `Gmail OAuth: retired duplicate channel ${c.id} (keep=${existing.id})`,
          );
        }
        return `${base}?gmail=connected&updated=1&email=${encodeURIComponent(email || '')}`;
      }

      // Create path — precisa de refresh_token novo
      if (!tokens.refresh_token) {
        return `${base}?gmail=error&reason=${encodeURIComponent('no_refresh_token')}`;
      }

      const channelName =
        payload.name && payload.name !== 'Gmail'
          ? payload.name
          : email
            ? `Gmail · ${email}`
            : 'Gmail';

      const created = await this.channelsService.create(
        payload.orgId,
        {
          type: ChannelType.GMAIL,
          name: channelName,
          visibility: payload.visibility,
          config: {
            email: email || undefined,
            refreshToken: tokens.refresh_token,
            scope,
            connectedAt: new Date().toISOString(),
            auth: 'oauth_platform_app',
          },
        },
        {
          userOrganizationId: payload.uoId,
          role: payload.role,
        },
      );

      if (email && created?.id) {
        await this.softDeleteDuplicateGmailChannels(
          payload.orgId,
          email,
          created.id,
        );
      }

      return `${base}?gmail=connected&email=${encodeURIComponent(email || '')}`;
    } catch (err: any) {
      this.logger.error(`Gmail OAuth callback failed: ${err.message}`, err.stack);
      const reason = err?.response?.data?.error || err.message || 'callback_failed';
      return `${base}?gmail=error&reason=${encodeURIComponent(String(reason).slice(0, 180))}`;
    }
  }

  /** Desativa outros canais Gmail da mesma conta na org (limpa spam de reconnect). */
  private async softDeleteDuplicateGmailChannels(
    organizationId: string,
    email: string,
    keepId: string,
  ): Promise<void> {
    const all = await this.prisma.channel.findMany({
      where: {
        organizationId,
        type: ChannelType.GMAIL,
        deletedAt: null,
        id: { not: keepId },
      },
    });
    const now = new Date();
    for (const c of all) {
      const cfgEmail = String(((c.config as any) || {}).email || '').toLowerCase();
      if (cfgEmail && cfgEmail === email.toLowerCase()) {
        await this.prisma.channel.update({
          where: { id: c.id },
          data: { deletedAt: now, isActive: false },
        });
        this.logger.warn(
          `Gmail OAuth: soft-deleted duplicate channel ${c.id} (email=${email}, keep=${keepId})`,
        );
      }
    }
  }

  private async exchangeCode(code: string): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  }> {
    const { data } = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
        redirect_uri: this.redirectUri(),
        grant_type: 'authorization_code',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20_000,
      },
    );
    return data;
  }

  private async fetchEmail(accessToken: string): Promise<string> {
    try {
      const { data } = await axios.get(
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15_000,
        },
      );
      return String(data.emailAddress || '').toLowerCase();
    } catch {
      try {
        const { data } = await axios.get(
          'https://www.googleapis.com/oauth2/v2/userinfo',
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15_000,
          },
        );
        return String(data.email || '').toLowerCase();
      } catch {
        return '';
      }
    }
  }

  private signState(payload: OAuthStatePayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = createHmac('sha256', this.stateSecret()).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  private verifyState(state: string): OAuthStatePayload {
    const [body, sig] = state.split('.');
    if (!body || !sig) throw new BadRequestException('state malformed');
    const expected = createHmac('sha256', this.stateSecret()).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('state signature mismatch');
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
    if (payload.v !== 1) throw new BadRequestException('state version');
    if (!payload.orgId || !payload.uoId) throw new BadRequestException('state tenant missing');
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new BadRequestException('state expired');
    }
    return payload;
  }
}
