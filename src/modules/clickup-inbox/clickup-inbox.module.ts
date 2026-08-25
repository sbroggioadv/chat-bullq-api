import { Module } from '@nestjs/common';
import { ClickUpInboxController } from './clickup-inbox.controller';
import { ClickUpInboxService } from './clickup-inbox.service';
import { ClickUpInboxConfigService } from './clickup-inbox-config.service';
import { ClickUpInboxHttpClient } from './clickup-inbox-http.client';
import { ClickUpMatchService } from './clickup-match.service';
import { CLICKUP_ATIVIDADE_KV, CLICKUP_FETCH, CLICKUP_W2_STORE } from './clickup-inbox.tokens';
import { ClickUpInboxRedisKv } from './clickup-inbox-redis.kv';

@Module({
  controllers: [ClickUpInboxController],
  providers: [
    {
      provide: CLICKUP_FETCH,
      useValue: globalThis.fetch.bind(globalThis),
    },
    ClickUpInboxRedisKv,
    {
      provide: CLICKUP_ATIVIDADE_KV,
      useExisting: ClickUpInboxRedisKv,
    },
    {
      provide: CLICKUP_W2_STORE,
      useExisting: ClickUpInboxRedisKv,
    },
    ClickUpInboxConfigService,
    ClickUpInboxHttpClient,
    ClickUpMatchService,
    ClickUpInboxService,
  ],
  exports: [ClickUpInboxService],
})
export class ClickUpInboxModule {}
