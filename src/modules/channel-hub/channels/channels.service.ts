import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ChannelType, ChannelSyncMode, ChannelSyncStatus, OrgRole } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelsRepository } from './channels.repository';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { ZappfyHttpClient } from '../adapters/zappfy/zappfy.http-client';
import { ZappfyMessageMapper } from '../adapters/zappfy/zappfy.message-mapper';
import { WhatsAppOfficialHttpClient } from '../adapters/whatsapp-official/whatsapp-official.http-client';
import { InstagramHttpClient } from '../adapters/instagram/instagram.http-client';
import { InstagramMessageMapper } from '../adapters/instagram/instagram.message-mapper';
import { ChannelSyncOrchestrator } from '../sync/channel-sync.orchestrator';
import {
  ChannelAccessService,
  type ChannelAccess,
} from '../../iam/channel-access/channel-access.service';

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly repository: ChannelsRepository,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly zappfyHttpClient: ZappfyHttpClient,
    private readonly waOfficialHttpClient: WhatsAppOfficialHttpClient,
    private readonly instagramHttpClient: InstagramHttpClient,
    private readonly zappfyMapper: ZappfyMessageMapper,
    private readonly instagramMapper: InstagramMessageMapper,
    private readonly syncOrchestrator: ChannelSyncOrchestrator,
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessService,
  ) {}

  async create(
    organizationId: string,
    dto: CreateChannelDto,
    creator?: { userOrganizationId: string; role: OrgRole },
  ) {
    const effectiveVisibility = dto.visibility ?? 'PRIVATE';
    let channel = await this.repository.create({
      organizationId,
      type: dto.type,
      name: dto.name,
      config: dto.config,
      webhookSecret: dto.webhookSecret,
      visibility: effectiveVisibility,
    });

    // Deny-by-default: a brand new channel has no agents, so AGENT users in the
    // org cannot see it. The creator gets an explicit grant only if they are
    // an AGENT (OWNER/ADMIN bypass via role); admins manage other agents'
    // access via the channel-access endpoints.
    //
    // Pra canal PRIVATE, OWNER/ADMIN também precisa de grant — então se o
    // criador é um deles E o canal é PRIVATE, garantimos o grant pra evitar
    // que o criador se tranque fora do próprio canal recém-criado.
    const needsAgentGrant =
      (creator && creator.role === OrgRole.AGENT) ||
      (creator && effectiveVisibility === 'PRIVATE');
    if (needsAgentGrant && creator) {
      await this.prisma.channelAgent.create({
        data: {
          channelId: channel.id,
          userOrganizationId: creator.userOrganizationId,
        },
      });
    }

    // Enrich config with provider-side identifiers that the webhook router
    // needs to match incoming events. Without these, the new routing (P0-1)
    // correctly drops webhooks as "unknown locator".
    channel = (await this.enrichProviderIds(channel.id, dto.type)) ?? channel;

    // Zappfy needs its webhook configured on the provider side. Fire-and-forget.
    if (dto.type === ChannelType.WHATSAPP_ZAPPFY) {
      this.configureZappfyWebhook(channel.id).catch((err) =>
        this.logger.warn(`Zappfy webhook config failed: ${err.message}`),
      );
    }

    // WA Official needs the app explicitly subscribed to the WABA before Meta
    // starts delivering webhooks. Fire-and-forget — fails silently when the
    // token lacks `whatsapp_business_management` scope or businessAccountId
    // is missing; the user can retry via PATCH /channels/:id/test.
    if (dto.type === ChannelType.WHATSAPP_OFFICIAL) {
      this.subscribeWaOfficialApp(channel.id).catch((err) =>
        this.logger.warn(
          `WA Official subscribe failed for channel ${channel.id}: ${err.message}`,
        ),
      );
    }

    // Unified sync path — any adapter that registered a HistorySyncPort.
    if (this.adapterRegistry.hasHistorySync(dto.type)) {
      this.syncOrchestrator
        .start(channel.id, { mode: ChannelSyncMode.INITIAL })
        .catch((err) =>
          this.logger.error(
            `Auto-sync enqueue failed for channel ${channel.id}: ${err.message}`,
          ),
        );
    }

    return channel;
  }

  /**
   * Ensures the channel's config contains the provider-side IDs used by the
   * webhook router (`igBusinessId` / `phoneNumberId`). Idempotent: skipped
   * when the IDs are already present. Runs synchronously because the webhook
   * router uses these fields and we'd rather fail channel creation than
   * silently produce an unroutable channel.
   */
  async enrichProviderIds(channelId: string, type: ChannelType) {
    try {
      const channel = await this.repository.findById(channelId);
      if (!channel) return null;
      const config = (channel.config as Record<string, any>) || {};

      if (type === ChannelType.INSTAGRAM && !config.igBusinessId) {
        const info = await this.instagramHttpClient.getMe(channel);
        const id = info?.user_id ?? info?.id;
        if (id) {
          return this.repository.update(channelId, {
            config: { ...config, igBusinessId: String(id) },
          });
        }
      }

      if (type === ChannelType.WHATSAPP_OFFICIAL && !config.phoneNumberId) {
        // phoneNumberId is part of Meta's onboarding output — if the user
        // didn't include it we can't guess, but we log loudly so it isn't silent.
        this.logger.warn(
          `WA Official channel ${channelId} created without config.phoneNumberId — webhooks will be dropped as unknown locator`,
        );
      }

      return channel;
    } catch (err: any) {
      this.logger.warn(
        `enrichProviderIds failed for channel ${channelId}: ${err.message}`,
      );
      return null;
    }
  }

  private async configureZappfyWebhook(channelId: string): Promise<void> {
    const channel = await this.repository.findById(channelId);
    if (!channel) return;
    const appUrl = process.env.APP_URL;
    if (!appUrl) {
      this.logger.warn('APP_URL not set — skipping Zappfy webhook setup');
      return;
    }
    const webhookUrl = `${appUrl}/api/v1/webhooks/WHATSAPP_ZAPPFY`;
    await this.zappfyHttpClient.configureWebhook(channel, webhookUrl);
    this.logger.log(`Zappfy webhook configured: ${webhookUrl}`);
  }

  private async subscribeWaOfficialApp(channelId: string): Promise<void> {
    const channel = await this.repository.findById(channelId);
    if (!channel) return;
    const config = (channel.config as Record<string, any>) || {};
    if (!config.businessAccountId) {
      this.logger.warn(
        `WA Official channel ${channelId} has no businessAccountId — skipping auto-subscribe (do it manually in Meta dashboard)`,
      );
      return;
    }
    await this.waOfficialHttpClient.subscribeApp(channel);
    this.logger.log(
      `WA Official app subscribed to WABA ${config.businessAccountId} (channel ${channelId})`,
    );
  }

  async findAll(organizationId: string, access: ChannelAccess) {
    const accessibleIds = access === 'ALL' ? undefined : [...access];
    return this.repository.findByOrganization(organizationId, accessibleIds);
  }

  async findOne(id: string, organizationId: string, access?: ChannelAccess) {
    const channel = await this.repository.findById(id);
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    if (access !== undefined && access !== 'ALL' && !access.has(id)) {
      throw new ForbiddenException('You do not have access to this channel');
    }
    return channel;
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateChannelDto,
    callerUserOrganizationId?: string,
  ) {
    await this.findOne(id, organizationId);

    // Visibility é tratado por caminho separado pra garantir auto-grant.
    const { visibility, ...rest } = dto;
    if (visibility && callerUserOrganizationId) {
      await this.channelAccess.setChannelVisibility(
        id,
        organizationId,
        visibility,
        callerUserOrganizationId,
      );
    }

    if (Object.keys(rest).length === 0) {
      return this.repository.findById(id);
    }
    return this.repository.update(id, rest);
  }

  /**
   * Soft-deletes a channel after verifying the caller typed its exact name.
   * Messages and conversations are preserved — they are flagged `deletedAt`
   * so they stop showing in UI without destroying history.
   */
  async remove(id: string, organizationId: string, confirmName?: string) {
    const channel = await this.findOne(id, organizationId);
    if (!confirmName || confirmName.trim() !== channel.name) {
      throw new BadRequestException(
        'Confirme digitando exatamente o nome do canal para remover.',
      );
    }
    return this.repository.softDelete(id);
  }

  async findActiveByType(type: ChannelType) {
    return this.repository.findActiveByType(type);
  }

  /**
   * Resolve the channel that owns a given webhook payload by asking the
   * inbound adapter to match against `config`. Returns null when no channel
   * matches — caller MUST drop the event (and ideally log for investigation).
   */
  async resolveByLocator(
    type: ChannelType,
    matches: (channel: { config: any }) => boolean,
  ) {
    const candidates = await this.repository.findActiveByType(type);
    return candidates.find((c) => matches(c)) ?? null;
  }

  async syncChannel(id: string, organizationId: string) {
    const channel = await this.findOne(id, organizationId);

    if (!this.adapterRegistry.hasHistorySync(channel.type)) {
      return {
        success: false,
        error: `Sync not supported for channel type ${channel.type}`,
      };
    }

    const job = await this.syncOrchestrator.start(channel.id, {
      mode: ChannelSyncMode.MANUAL,
    });
    return { success: true, jobId: job.id, status: job.status };
  }

  async getSyncStatus(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    const job = await this.prisma.channelSyncJob.findFirst({
      where: { channelId: id },
      orderBy: { createdAt: 'desc' },
    });
    return { job };
  }

  async cancelSync(id: string, organizationId: string) {
    const channel = await this.findOne(id, organizationId);

    if (this.adapterRegistry.hasHistorySync(channel.type)) {
      const job = await this.syncOrchestrator.cancel(id);
      return { job };
    }

    const active = await this.prisma.channelSyncJob.findFirst({
      where: {
        channelId: id,
        status: { in: [ChannelSyncStatus.PENDING, ChannelSyncStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) return { job: null };

    const job = await this.prisma.channelSyncJob.update({
      where: { id: active.id },
      data: { status: ChannelSyncStatus.CANCELLED, finishedAt: new Date() },
    });
    return { job };
  }

  async testConnection(id: string, organizationId: string) {
    const channel = await this.findOne(id, organizationId);

    try {
      switch (channel.type) {
        case ChannelType.WHATSAPP_ZAPPFY: {
          const status = await this.zappfyHttpClient.getInstanceStatus(channel);
          const rawState = status?.state;
          const statusStr =
            typeof rawState === 'string'
              ? rawState
              : typeof rawState === 'object' && rawState?.status
                ? String(rawState.status)
                : typeof status?.status === 'string'
                  ? status.status
                  : 'connected';
          return {
            success: true,
            status: statusStr,
            data: status,
          };
        }

        case ChannelType.WHATSAPP_OFFICIAL: {
          const info = await this.waOfficialHttpClient.verifyPhoneNumber(channel);
          return {
            success: true,
            status: 'connected',
            data: {
              phoneNumber: info.display_phone_number,
              qualityRating: info.quality_rating,
              verifiedName: info.verified_name,
            },
          };
        }

        case ChannelType.INSTAGRAM: {
          const info = await this.instagramHttpClient.getMe(channel);
          return {
            success: true,
            status: 'connected',
            data: {
              username: info.username,
              igUserId: info.user_id || info.id,
              accountType: info.account_type,
              name: info.name,
            },
          };
        }

        default:
          return { success: false, error: 'Unsupported channel type' };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
      };
    }
  }

  /**
   * Backfill: re-processa o rawPayload de mensagens problemáticas pelos
   * mappers atualizados. Corrige `[ig reel]`, `[Unsupported message]`,
   * `[Tipo: ...]` e afins que foram persistidos antes dos fixes dos mappers.
   *
   * Escopo: um canal por vez. Só reprocessa mensagens cujo content.text
   * corresponde a um placeholder entre colchetes (sinal de fallback cego).
   */
  /**
   * Org-wide backfill for every Instagram + Zappfy channel. Used after
   * mapper fixes so Fireflies / chatbot history with [Unsupported…] is
   * rewritten without calling one channel at a time.
   */
  async backfillMessageContentAll(orgId: string): Promise<{
    channels: number;
    scanned: number;
    updated: number;
    unchanged: number;
    errors: number;
    perChannel: Array<{
      channelId: string;
      name: string;
      scanned: number;
      updated: number;
      unchanged: number;
      errors: number;
    }>;
  }> {
    const channels = await this.prisma.channel.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        type: {
          in: [ChannelType.WHATSAPP_ZAPPFY, ChannelType.INSTAGRAM],
        },
      },
      select: { id: true, name: true },
    });

    const perChannel: Array<{
      channelId: string;
      name: string;
      scanned: number;
      updated: number;
      unchanged: number;
      errors: number;
    }> = [];
    let scanned = 0;
    let updated = 0;
    let unchanged = 0;
    let errors = 0;

    for (const ch of channels) {
      try {
        const r = await this.backfillMessageContent(ch.id, orgId);
        perChannel.push({ channelId: ch.id, name: ch.name, ...r });
        scanned += r.scanned;
        updated += r.updated;
        unchanged += r.unchanged;
        errors += r.errors;
      } catch (err: any) {
        this.logger.warn(
          `backfill-all skip channel ${ch.id}: ${err.message}`,
        );
        perChannel.push({
          channelId: ch.id,
          name: ch.name,
          scanned: 0,
          updated: 0,
          unchanged: 0,
          errors: 1,
        });
        errors++;
      }
    }

    this.logger.log(
      `Backfill ALL org=${orgId}: channels=${channels.length} scanned=${scanned} updated=${updated}`,
    );
    return {
      channels: channels.length,
      scanned,
      updated,
      unchanged,
      errors,
      perChannel,
    };
  }

  async backfillMessageContent(
    channelId: string,
    orgId: string,
  ): Promise<{ scanned: number; updated: number; unchanged: number; errors: number }> {
    const channel = await this.findOne(channelId, orgId);
    if (!channel) throw new NotFoundException('Channel not found');

    const mapper =
      channel.type === ChannelType.INSTAGRAM
        ? this.instagramMapper
        : channel.type === ChannelType.WHATSAPP_ZAPPFY
          ? this.zappfyMapper
          : null;

    if (!mapper) {
      throw new BadRequestException(`Backfill not supported for channel type: ${channel.type}`);
    }

    // Placeholder patterns from old mappers / provider failures:
    //  - exact [Unsupported message type]
    //  - [Tipo: xyz] / [ig reel]
    //  - [Undecryptable] …
    //  - text that is ONLY a bracketed token
    const isPlaceholder = (text: string): boolean => {
      const t = text.trim();
      if (!t) return false;
      if (/^\[Unsupported message type\]$/i.test(t)) return true;
      if (/^\[Unsupported message\]$/i.test(t)) return true;
      if (/^\[Tipo:\s*.+\]$/i.test(t)) return true;
      if (/^\[.+\]$/.test(t)) return true;
      if (/^\[Undecryptable\]/i.test(t)) return true;
      if (/Unsupported message type/i.test(t) && t.length < 80) return true;
      return false;
    };

    // Busca mensagens desse canal em lotes. Filtra em memória porque
    // filtrar dentro de JSON content->>'text' é mais frágil no Prisma.
    const BATCH = 500;
    let cursor: string | undefined;
    let scanned = 0;
    let updated = 0;
    let unchanged = 0;
    let errors = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const messages: any[] = await this.prisma.message.findMany({
        where: {
          conversation: { channelId },
        },
        select: {
          id: true,
          type: true,
          content: true,
          metadata: true,
        },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });

      if (messages.length === 0) break;

      for (const msg of messages) {
        scanned++;
        const text =
          typeof msg.content?.text === 'string' ? msg.content.text : '';
        const looksBad =
          isPlaceholder(text) ||
          // Interactive with empty/placeholder body (botões sem texto legível)
          (msg.type === 'INTERACTIVE' &&
            (!text || isPlaceholder(text) || text.length < 2));
        if (!looksBad) {
          continue;
        }

        const rawPayload =
          msg.metadata?.rawPayload ||
          msg.metadata?.raw ||
          msg.metadata?.payload;
        if (!rawPayload) {
          unchanged++;
          continue;
        }

        try {
          const reprocessed = mapper.normalizeInbound(rawPayload);
          if (!reprocessed) {
            unchanged++;
            continue;
          }

          const newText = reprocessed.content.text;
          // Só atualiza se o conteúdo mudou (evita writes desnecessários).
          if (newText === text && reprocessed.type === msg.type) {
            unchanged++;
            continue;
          }

          await this.prisma.message.update({
            where: { id: msg.id },
            data: {
              type: reprocessed.type as any,
              content: reprocessed.content as any,
            },
          });
          updated++;
        } catch (err: any) {
          this.logger.warn(
            `Backfill error on message ${msg.id}: ${err.message}`,
          );
          errors++;
        }
      }

      if (messages.length < BATCH) break;
      cursor = messages[messages.length - 1].id;
    }

    this.logger.log(
      `Backfill channel=${channelId} (${channel.type}): scanned=${scanned} updated=${updated} unchanged=${unchanged} errors=${errors}`,
    );

    return { scanned, updated, unchanged, errors };
  }
}
