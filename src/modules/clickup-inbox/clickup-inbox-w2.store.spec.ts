import { RedisW2Store, redisUnavailable, type RedisLockClient } from './clickup-inbox-w2.store';
import { CLICKUP_REDIS_REQUEST_OPTIONS } from './clickup-inbox-redis.kv';

function client(overrides: Partial<RedisLockClient> = {}): RedisLockClient {
  return {
    ping: async () => 'PONG',
    get: async () => null,
    set: async () => 'OK',
    eval: async () => 1,
    ...overrides,
  };
}

describe('RedisW2Store (F-02)', () => {
  it('não espera reconexão indefinida', () => {
    expect(CLICKUP_REDIS_REQUEST_OPTIONS.maxRetriesPerRequest).toBe(1);
    expect(CLICKUP_REDIS_REQUEST_OPTIONS.commandTimeout).toBe(3_000);
    expect(CLICKUP_REDIS_REQUEST_OPTIONS.connectTimeout).toBe(3_000);
    expect(CLICKUP_REDIS_REQUEST_OPTIONS.enableOfflineQueue).toBe(false);
  });

  it('PING falha como erro redis', async () => {
    const store = new RedisW2Store(client({ ping: async () => { throw new Error('PING down'); } }));
    await expect(store.assertReady()).rejects.toMatchObject({ redis: true, message: 'redis indisponível' });
  });

  it('PING ok e GET falha como erro redis', async () => {
    const store = new RedisW2Store(client({
      get: async () => { throw new Error('GET down'); },
    }));
    await store.assertReady();
    await expect(store.getReceipt('org-a', '551198765432', 'k')).rejects.toMatchObject({ redis: true });
  });

  it('SET NX falha como erro redis', async () => {
    const store = new RedisW2Store(client({
      set: async () => { throw new Error('SET down'); },
    }));
    await expect(store.acquireLock('org-a', '551198765432')).rejects.toMatchObject({ redis: true });
  });

  it('SET receipt falha como erro redis', async () => {
    const store = new RedisW2Store(client({
      set: async () => { throw new Error('SET receipt down'); },
    }));
    await expect(
      store.finalizeReceipt('org-a', '551198765432', 'k', 'task-1'),
    ).rejects.toMatchObject({ redis: true });
  });

  it('redisUnavailable marca o erro', () => {
    expect(redisUnavailable().redis).toBe(true);
  });
});
