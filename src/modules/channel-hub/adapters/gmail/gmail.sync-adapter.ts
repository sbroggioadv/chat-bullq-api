import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import { HistorySyncPort } from '../../ports/history-sync.port';
import {
  FetchConversationsResult,
  FetchMessagesResult,
  HistorySyncFilters,
  NormalizedHistoricalConversation,
  SyncCapabilities,
} from '../../ports/types';
import { GmailHttpClient } from './gmail.http-client';
import {
  normalizeGmailMessage,
  pickThreadContact,
} from './gmail.message-mapper';

@Injectable()
export class GmailSyncAdapter implements HistorySyncPort {
  readonly channelType = ChannelType.GMAIL;
  private readonly logger = new Logger(GmailSyncAdapter.name);
  private readonly profileCache = new Map<string, string>();

  constructor(private readonly http: GmailHttpClient) {}

  getSyncCapabilities(): SyncCapabilities {
    return {
      supportsHistoryImport: true,
      supportsDeltaSync: true,
      defaultLookbackDays: 14,
      maxLookbackDays: 90,
    };
  }

  private async myEmail(channel: Channel): Promise<string> {
    const cached = this.profileCache.get(channel.id);
    if (cached) return cached;
    const cfg = (channel.config as any) || {};
    if (cfg.email) {
      this.profileCache.set(channel.id, String(cfg.email).toLowerCase());
      return String(cfg.email).toLowerCase();
    }
    const profile = await this.http.getProfile(channel);
    const email = String(profile.emailAddress || '').toLowerCase();
    this.profileCache.set(channel.id, email);
    return email;
  }

  async fetchConversations(
    channel: Channel,
    filters: HistorySyncFilters,
    cursor?: string,
    limit = 30,
  ): Promise<FetchConversationsResult> {
    const my = await this.myEmail(channel);
    // Gmail q date filter: after:YYYY/MM/DD
    let q = ((channel.config as any)?.query as string) || 'in:inbox';
    if (filters.sinceTimestamp) {
      const d = filters.sinceTimestamp;
      const after = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      q = `${q} after:${after}`;
    }

    const page = await this.http.listThreads(channel, {
      pageToken: cursor,
      maxResults: limit,
      q,
    });

    const conversations: NormalizedHistoricalConversation[] = [];

    // Gmail list only returns ids — hydrate each thread (bounded page)
    for (const t of page.threads) {
      try {
        const full = await this.http.getThread(channel, t.id);
        const msgs = (full.messages || [])
          .map((m: any) => normalizeGmailMessage(m, t.id, my))
          .filter(Boolean) as ReturnType<typeof normalizeGmailMessage>[];
        if (msgs.length === 0) continue;

        const last = msgs.reduce((a, b) => (a!.timestamp > b!.timestamp ? a : b));
        if (filters.sinceTimestamp && last!.timestamp < filters.sinceTimestamp) {
          // threads are not strictly ordered by last message in all queries;
          // still include if any message is in range — skip only if last < since
          // and no message in range
          const anyInRange = msgs.some((m) => m!.timestamp >= filters.sinceTimestamp!);
          if (!anyInRange) continue;
        }

        const contact = pickThreadContact(msgs as any, my);
        const unread = (full.messages || []).some((m: any) =>
          (m.labelIds || []).includes('UNREAD'),
        )
          ? 1
          : 0;

        conversations.push({
          externalConversationId: t.id,
          externalContactId: contact.externalContactId,
          contactName: contact.contactName,
          contactPhone: contact.externalContactId.includes('@')
            ? undefined
            : contact.externalContactId,
          lastMessageAt: last!.timestamp,
          unreadCount: unread,
          isGroup: false,
          rawPayload: { threadId: t.id, snippet: full.snippet || t.snippet },
        });
      } catch (err: any) {
        this.logger.warn(`Gmail thread ${t.id} hydrate failed: ${err.message}`);
      }
    }

    return {
      conversations,
      nextCursor: page.nextPageToken,
    };
  }

  async fetchMessages(
    channel: Channel,
    externalConversationId: string,
    filters: HistorySyncFilters,
    _cursor?: string,
    _limit = 100,
  ): Promise<FetchMessagesResult> {
    const my = await this.myEmail(channel);
    const full = await this.http.getThread(channel, externalConversationId);
    const messages = (full.messages || [])
      .map((m: any) => normalizeGmailMessage(m, externalConversationId, my))
      .filter(Boolean) as NonNullable<ReturnType<typeof normalizeGmailMessage>>[];

    const filtered = filters.sinceTimestamp
      ? messages.filter((m) => m.timestamp >= filters.sinceTimestamp!)
      : messages;

    // oldest → newest for import stability
    filtered.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return { messages: filtered };
  }
}
