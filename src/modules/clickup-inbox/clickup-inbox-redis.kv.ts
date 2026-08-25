import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { buildRedisConnectionOptions } from '../../config/redis.config';
import {
  RedisAtividadeKv,
  type AtividadeKv,
  type AtividadeRegistro,
} from './domain/criacao-atividade';

@Injectable()
export class ClickUpInboxRedisKv implements AtividadeKv, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly inner: RedisAtividadeKv;

  constructor(config: ConfigService) {
    this.redis = new Redis(
      buildRedisConnectionOptions(config, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      }),
    );
    this.inner = new RedisAtividadeKv(this.redis);
  }

  get(chave: string) {
    return this.inner.get(chave);
  }

  set(objeto: Record<string, AtividadeRegistro>) {
    return this.inner.set(objeto);
  }

  remove(chave: string) {
    return this.inner.remove(chave);
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      /* noop */
    }
  }
}
