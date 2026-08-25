import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import { buildRedisConnectionOptions } from '../../config/redis.config';
import {
  RedisAtividadeKv,
  type AtividadeKv,
  type AtividadeRegistro,
} from './domain/criacao-atividade';
import { RedisW2Store, type ClickUpW2Store } from './clickup-inbox-w2.store';

/** Finite Redis budget: never wait indefinitely for a dead connection. */
export const CLICKUP_REDIS_REQUEST_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: 1,
  connectTimeout: 3_000,
  commandTimeout: 3_000,
  enableOfflineQueue: false,
  enableReadyCheck: true,
};

@Injectable()
export class ClickUpInboxRedisKv implements AtividadeKv, ClickUpW2Store, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly inner: RedisAtividadeKv;
  private readonly w2: RedisW2Store;

  constructor(config: ConfigService) {
    this.redis = new Redis(
      buildRedisConnectionOptions(config, CLICKUP_REDIS_REQUEST_OPTIONS),
    );
    this.inner = new RedisAtividadeKv(this.redis);
    this.w2 = new RedisW2Store(this.redis);
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

  assertReady() {
    return this.w2.assertReady();
  }

  acquireLock(organizationId: string, telefoneCanonico: string, ttlMs?: number) {
    return this.w2.acquireLock(organizationId, telefoneCanonico, ttlMs);
  }

  releaseLock(organizationId: string, telefoneCanonico: string, token: string) {
    return this.w2.releaseLock(organizationId, telefoneCanonico, token);
  }

  getReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    return this.w2.getReceipt(organizationId, telefoneCanonico, idempotencyKey);
  }

  beginReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    return this.w2.beginReceipt(organizationId, telefoneCanonico, idempotencyKey);
  }

  finalizeReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
    taskId: string,
  ) {
    return this.w2.finalizeReceipt(organizationId, telefoneCanonico, idempotencyKey, taskId);
  }

  clearReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    return this.w2.clearReceipt(organizationId, telefoneCanonico, idempotencyKey);
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      /* noop */
    }
  }
}
