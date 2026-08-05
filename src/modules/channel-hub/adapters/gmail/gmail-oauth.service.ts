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
import { ChannelsService } from '../../channels/channels.service';

export interface GmailOAuthStartInput {
  organizationId: string;
  userOrganizationId: string;
  role: OrgRole;
  name?: string;
  visibility?: 'ORG' | 'PRIVATE';
}

interface OAuthStatePayload {
  v: 1;
  orgId: string;
  uoId: string;
  role: OrgRole;
  name: string;
  visibility: 'ORG' | 'PRIVATE';
  nonce: string;
  exp: number;
}

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
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
   * Callback do Google. Cria canal GMAIL na org do state e devolve URL de redirect pro web.
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
      if (!tokens.refresh_token) {
        // Google só devolve refresh_token no primeiro consent / prompt=consent.
        return `${base}?gmail=error&reason=${encodeURIComponent('no_refresh_token')}`;
      }

      const email = await this.fetchEmail(tokens.access_token);
      const channelName =
        payload.name && payload.name !== 'Gmail'
          ? payload.name
          : email
            ? `Gmail · ${email}`
            : 'Gmail';

      // Credenciais do tenant ficam APENAS no config do canal.
      // Nunca grava clientSecret no banco — usa o da plataforma em runtime.
      await this.channelsService.create(
        payload.orgId,
        {
          type: ChannelType.GMAIL,
          name: channelName,
          visibility: payload.visibility,
          config: {
            email: email || undefined,
            refreshToken: tokens.refresh_token,
            scope: tokens.scope || GMAIL_SCOPES,
            connectedAt: new Date().toISOString(),
            // marca origem do conector (auditoria multi-tenant)
            auth: 'oauth_platform_app',
          },
        },
        {
          userOrganizationId: payload.uoId,
          role: payload.role,
        },
      );

      return `${base}?gmail=connected&email=${encodeURIComponent(email || '')}`;
    } catch (err: any) {
      this.logger.error(`Gmail OAuth callback failed: ${err.message}`, err.stack);
      const reason = err?.response?.data?.error || err.message || 'callback_failed';
      return `${base}?gmail=error&reason=${encodeURIComponent(String(reason).slice(0, 180))}`;
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
