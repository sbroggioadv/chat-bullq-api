import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

interface GmailConfig {
  email?: string;
  /** Refresh token da CONTA Google deste canal (tenant). Obrigatório. */
  refreshToken?: string;
  /** @deprecated não usar — client fica na plataforma */
  clientId?: string;
  /** @deprecated não usar — client fica na plataforma */
  clientSecret?: string;
  /** Gmail search query (default in:inbox) */
  query?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
}

/**
 * Gmail API client multi-tenant.
 *
 * - App OAuth (client id/secret): env da plataforma.
 * - Refresh token: SEMPRE `channel.config.refreshToken` (por org/canal).
 *   Nunca cai em refresh token global de env — isso quebraria isolamento multi-tenant.
 */
@Injectable()
export class GmailHttpClient {
  private readonly logger = new Logger(GmailHttpClient.name);
  private readonly tokenCache = new Map<string, CachedToken>();
  private readonly base = 'https://gmail.googleapis.com/gmail/v1';

  private cfg(channel: Channel): GmailConfig {
    return ((channel.config as GmailConfig) || {}) as GmailConfig;
  }

  private platformClient() {
    const clientId =
      process.env.GMAIL_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    const clientSecret =
      process.env.GMAIL_OAUTH_CLIENT_SECRET ||
      process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
      '';
    if (!clientId || !clientSecret) {
      throw new Error(
        'Gmail platform OAuth missing: set GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET (or GOOGLE_OAUTH_*)',
      );
    }
    return { clientId, clientSecret };
  }

  private refreshTokenForChannel(channel: Channel): string {
    const c = this.cfg(channel);
    const token = (c.refreshToken || '').trim();
    if (!token) {
      throw new Error(
        `Canal Gmail ${channel.id} sem refreshToken no config — reconecte via Conectar com Google`,
      );
    }
    return token;
  }

  async getAccessToken(channel: Channel): Promise<string> {
    const cached = this.tokenCache.get(channel.id);
    if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

    const { clientId, clientSecret } = this.platformClient();
    const refreshToken = this.refreshTokenForChannel(channel);

    const resp = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15_000,
      },
    );
    const accessToken: string = resp.data.access_token;
    const expiresIn: number = resp.data.expires_in ?? 3600;
    this.tokenCache.set(channel.id, {
      accessToken,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
    });
    return accessToken;
  }

  private async client(channel: Channel): Promise<AxiosInstance> {
    const token = await this.getAccessToken(channel);
    return axios.create({
      baseURL: this.base,
      timeout: 30_000,
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async getProfile(
    channel: Channel,
  ): Promise<{ emailAddress: string; messagesTotal?: number; threadsTotal?: number }> {
    const http = await this.client(channel);
    const { data } = await http.get('/users/me/profile');
    return data;
  }

  async listLabels(channel: Channel): Promise<GmailLabel[]> {
    const http = await this.client(channel);
    const { data } = await http.get('/users/me/labels');
    return (data.labels || []) as GmailLabel[];
  }

  async listThreads(
    channel: Channel,
    opts: {
      pageToken?: string;
      maxResults?: number;
      q?: string;
      labelIds?: string[];
      includeSpamTrash?: boolean;
    } = {},
  ): Promise<{
    threads: Array<{ id: string; historyId?: string; snippet?: string }>;
    nextPageToken?: string;
  }> {
    const http = await this.client(channel);
    const c = this.cfg(channel);
    // URLSearchParams para suportar `labelIds` repetido (axios serializaria
    // como labelIds[]=…, que a API do Google ignora).
    const params = new URLSearchParams();
    params.set('maxResults', String(opts.maxResults ?? 50));
    if (opts.pageToken) params.set('pageToken', opts.pageToken);
    if (opts.labelIds?.length) {
      for (const id of opts.labelIds) params.append('labelIds', id);
    } else {
      params.set('q', opts.q ?? c.query ?? 'in:inbox');
    }
    if (opts.includeSpamTrash) params.set('includeSpamTrash', 'true');
    const { data } = await http.get('/users/me/threads', { params });
    return {
      threads: data.threads || [],
      nextPageToken: data.nextPageToken,
    };
  }

  async getThread(channel: Channel, threadId: string): Promise<Record<string, any>> {
    const http = await this.client(channel);
    const { data } = await http.get(`/users/me/threads/${encodeURIComponent(threadId)}`, {
      params: { format: 'full' },
    });
    return data;
  }

  /** Thread leve pra listagem: só headers Subject/From/Date + labelIds/snippet. */
  async getThreadMetadata(
    channel: Channel,
    threadId: string,
  ): Promise<Record<string, any>> {
    const http = await this.client(channel);
    const params = new URLSearchParams();
    params.set('format', 'metadata');
    for (const h of ['Subject', 'From', 'Date']) params.append('metadataHeaders', h);
    const { data } = await http.get(
      `/users/me/threads/${encodeURIComponent(threadId)}`,
      { params },
    );
    return data;
  }

  /**
   * Envia mensagem (reply/compose). Exige scope gmail.send no refresh token.
   * `raw` = RFC 2822 em base64url (sem padding).
   */
  async sendRawMessage(
    channel: Channel,
    rawBase64Url: string,
    threadId?: string,
  ): Promise<{ id: string; threadId: string; labelIds?: string[] }> {
    const http = await this.client(channel);
    const body: Record<string, string> = { raw: rawBase64Url };
    if (threadId) body.threadId = threadId;
    const { data } = await http.post('/users/me/messages/send', body);
    return {
      id: String(data.id),
      threadId: String(data.threadId || threadId || ''),
      labelIds: data.labelIds,
    };
  }
}
