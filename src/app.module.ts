import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './database/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ThemePresetsModule } from './modules/theme-presets/theme-presets.module';
import { ChannelHubModule } from './modules/channel-hub/channel-hub.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RoutingModule } from './modules/routing/routing.module';
import { QuickRepliesModule } from './modules/quick-replies/quick-replies.module';
import { TagsModule } from './modules/tags/tags.module';
import { ChatbotModule } from './modules/chatbot/chatbot.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { PublicApiModule } from './modules/public-api/public-api.module';
import { ChannelAccessModule } from './modules/iam/channel-access/channel-access.module';
import { AiAgentsModule } from './modules/ai-agents/ai-agents.module';
import { InboxViewsModule } from './modules/inbox-views/inbox-views.module';
import { PipelinesModule } from './modules/pipelines/pipelines.module';
import { SegmentsModule } from './modules/segments/segments.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { AutomationsModule } from './modules/automations/automations.module';
import { HealthModule } from './modules/health/health.module';
import { StorageModule } from './modules/storage/storage.module';
import { OrgCredentialsModule } from './modules/org-credentials/org-credentials.module';
// ProductsModule removido — catálogo agora vive no Trivapp e é consumido
// via skill HTTP getProductPitch + CatalogSyncService. Tabela `products`
// fica órfã no DB (cleanup futuro). Não importar aqui.
import redisConfig, { buildRedisConnectionOptions } from './config/redis.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildRedisConnectionOptions(config),
      }),
    }),
    PrismaModule,
    // AutomationsModule is @Global — register early so every domain
    // module can inject OutboxService without explicit imports.
    AutomationsModule,
    // StorageModule is @Global — bootstrap-only today (S17/C4): boot
    // guarantees the MinIO bucket exists. Registered early so future
    // consumers can inject StorageService without explicit imports.
    StorageModule,
    // OrgCredentialsModule is @Global — register early so ai-agents
    // resolver can inject OrgCredentialsService without circular imports.
    OrgCredentialsModule,
    ChannelAccessModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    ThemePresetsModule,
    RealtimeModule,
    ChannelHubModule,
    MessagingModule,
    NotificationsModule,
    RoutingModule,
    QuickRepliesModule,
    TagsModule,
    ChatbotModule,
    DashboardModule,
    RatingsModule,
    ApiKeysModule,
    PublicApiModule,
    AiAgentsModule,
    InboxViewsModule,
    PipelinesModule,
    SegmentsModule,
    ProjectsModule,
    HealthModule,
  ],
})
export class AppModule {}
