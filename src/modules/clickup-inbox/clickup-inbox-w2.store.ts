export const W2_LOCK_TTL_MS = 120_000;
export const W2_LOCK_WAIT_MS = 10_000;
export const W2_RECEIPT_TTL_SECONDS = 24 * 60 * 60;

export type ClickUpW2Store = {
  assertReady(): Promise<void>;
  acquireLock(organizationId: string, telefoneCanonico: string): Promise<string>;
  releaseLock(organizationId: string, telefoneCanonico: string, token: string): Promise<void>;
  getReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
  ): Promise<string | null>;
  setReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
    taskId: string,
  ): Promise<void>;
};

export function w2LockKey(organizationId: string, telefoneCanonico: string): string {
  return `clickup-inbox:w2-lock:${organizationId}:${telefoneCanonico}`;
}

export function w2ReceiptKey(
  organizationId: string,
  telefoneCanonico: string,
  idempotencyKey: string,
): string {
  return `clickup-inbox:w2-receipt:${organizationId}:${telefoneCanonico}:${idempotencyKey}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MemoryW2Store implements ClickUpW2Store {
  readonly receipts = new Map<string, string>();
  readonly locks = new Map<string, string>();
  private tails = new Map<string, Promise<void>>();
  private releasers = new Map<string, () => void>();
  failReady = false;

  async assertReady() {
    if (this.failReady) {
      const erro = new Error('redis indisponível') as Error & { redis: true };
      erro.redis = true;
      throw erro;
    }
  }

  async acquireLock(organizationId: string, telefoneCanonico: string): Promise<string> {
    await this.assertReady();
    const key = w2LockKey(organizationId, telefoneCanonico);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tails.get(key) ?? Promise.resolve();
    this.tails.set(key, previous.then(() => held));
    await previous;
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.locks.set(key, token);
    this.releasers.set(token, release);
    return token;
  }

  async releaseLock(organizationId: string, telefoneCanonico: string, token: string) {
    const key = w2LockKey(organizationId, telefoneCanonico);
    if (this.locks.get(key) !== token) return;
    this.locks.delete(key);
    const release = this.releasers.get(token);
    this.releasers.delete(token);
    release?.();
  }

  async getReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    await this.assertReady();
    return this.receipts.get(w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey)) ?? null;
  }

  async setReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
    taskId: string,
  ) {
    await this.assertReady();
    this.receipts.set(w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey), taskId);
  }
}

export type RedisLockClient = {
  ping(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...extras: unknown[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export class RedisW2Store implements ClickUpW2Store {
  constructor(private readonly redis: RedisLockClient) {}

  async assertReady() {
    try {
      await this.redis.ping();
    } catch (cause) {
      const erro = new Error('redis indisponível') as Error & { redis: true; cause?: unknown };
      erro.redis = true;
      erro.cause = cause;
      throw erro;
    }
  }

  async acquireLock(organizationId: string, telefoneCanonico: string): Promise<string> {
    await this.assertReady();
    const key = w2LockKey(organizationId, telefoneCanonico);
    const start = Date.now();
    while (Date.now() - start < W2_LOCK_WAIT_MS) {
      const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const ok = await this.redis.set(key, token, 'PX', W2_LOCK_TTL_MS, 'NX');
      if (ok === 'OK') return token;
      await delay(25 + Math.floor(Math.random() * 50));
    }
    const erro = new Error('não foi possível obter o lock de criação') as Error & { redis: true };
    erro.redis = true;
    throw erro;
  }

  async releaseLock(organizationId: string, telefoneCanonico: string, token: string) {
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;
    try {
      await this.redis.eval(script, 1, w2LockKey(organizationId, telefoneCanonico), token);
    } catch {
      /* lock expires */
    }
  }

  async getReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    await this.assertReady();
    return this.redis.get(w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey));
  }

  async setReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
    taskId: string,
  ) {
    await this.assertReady();
    await this.redis.set(
      w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey),
      taskId,
      'EX',
      W2_RECEIPT_TTL_SECONDS,
    );
  }
}
