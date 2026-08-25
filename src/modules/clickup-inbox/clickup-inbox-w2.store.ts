export const W2_LOCK_TTL_MS = 120_000;
export const W2_LOCK_WAIT_MS = 10_000;
export const W2_RECEIPT_TTL_SECONDS = 24 * 60 * 60;

export type W2Receipt =
  | { state: 'pending' }
  | { state: 'done'; taskId: string };

export type ClickUpW2Store = {
  assertReady(): Promise<void>;
  acquireLock(organizationId: string, telefoneCanonico: string): Promise<string>;
  releaseLock(organizationId: string, telefoneCanonico: string, token: string): Promise<void>;
  getReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
  ): Promise<W2Receipt | null>;
  beginReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
  ): Promise<W2Receipt>;
  finalizeReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
    taskId: string,
  ): Promise<void>;
  clearReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
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

export function parseW2Receipt(raw: string | null | undefined): W2Receipt | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as W2Receipt;
    if (parsed?.state === 'pending') return { state: 'pending' };
    if (parsed?.state === 'done' && typeof parsed.taskId === 'string' && parsed.taskId) {
      return { state: 'done', taskId: parsed.taskId };
    }
  } catch {
    if (/^[A-Za-z0-9_-]{1,128}$/.test(raw)) return { state: 'done', taskId: raw };
  }
  return null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function redisUnavailable(cause?: unknown): Error & { redis: true } {
  const erro = new Error('redis indisponível') as Error & { redis: true; cause?: unknown };
  erro.redis = true;
  erro.cause = cause;
  return erro;
}

export type MemoryW2Options = {
  receipts?: Map<string, string>;
  failReady?: boolean;
  failGet?: boolean;
  failSetNx?: boolean;
  failSetReceipt?: boolean;
  failLockSet?: boolean;
};

export class MemoryW2Store implements ClickUpW2Store {
  readonly receipts: Map<string, string>;
  readonly locks = new Map<string, string>();
  private tails = new Map<string, Promise<void>>();
  private releasers = new Map<string, () => void>();
  failReady: boolean;
  failGet: boolean;
  failSetNx: boolean;
  failSetReceipt: boolean;
  failLockSet: boolean;

  constructor(opts: MemoryW2Options = {}) {
    this.receipts = opts.receipts ?? new Map();
    this.failReady = Boolean(opts.failReady);
    this.failGet = Boolean(opts.failGet);
    this.failSetNx = Boolean(opts.failSetNx);
    this.failSetReceipt = Boolean(opts.failSetReceipt);
    this.failLockSet = Boolean(opts.failLockSet);
  }

  async assertReady() {
    if (this.failReady) throw redisUnavailable();
  }

  async acquireLock(organizationId: string, telefoneCanonico: string): Promise<string> {
    await this.assertReady();
    if (this.failLockSet) throw redisUnavailable();
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
    if (this.failGet) throw redisUnavailable();
    return parseW2Receipt(this.receipts.get(w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey)));
  }

  async beginReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    await this.assertReady();
    if (this.failSetNx) throw redisUnavailable();
    const key = w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey);
    const existing = parseW2Receipt(this.receipts.get(key));
    if (existing) return existing;
    this.receipts.set(key, JSON.stringify({ state: 'pending' }));
    return { state: 'pending' as const };
  }

  async finalizeReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
    taskId: string,
  ) {
    await this.assertReady();
    if (this.failSetReceipt) throw redisUnavailable();
    this.receipts.set(
      w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey),
      JSON.stringify({ state: 'done', taskId }),
    );
  }

  async clearReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    this.receipts.delete(w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey));
  }
}

export type RedisLockClient = {
  ping(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...extras: unknown[]): Promise<unknown>;
  del?(key: string): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export class RedisW2Store implements ClickUpW2Store {
  constructor(private readonly redis: RedisLockClient) {}

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      throw redisUnavailable(cause);
    }
  }

  async assertReady() {
    await this.call(() => this.redis.ping());
  }

  async acquireLock(organizationId: string, telefoneCanonico: string): Promise<string> {
    const key = w2LockKey(organizationId, telefoneCanonico);
    const start = Date.now();
    while (Date.now() - start < W2_LOCK_WAIT_MS) {
      const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const ok = await this.call(() => this.redis.set(key, token, 'PX', W2_LOCK_TTL_MS, 'NX'));
      if (ok === 'OK') return token;
      await delay(25 + Math.floor(Math.random() * 50));
    }
    throw redisUnavailable(new Error('não foi possível obter o lock de criação'));
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
      await this.call(() =>
        this.redis.eval(script, 1, w2LockKey(organizationId, telefoneCanonico), token),
      );
    } catch {
      /* lock expires */
    }
  }

  async getReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    const raw = await this.call(() =>
      this.redis.get(w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey)),
    );
    return parseW2Receipt(raw);
  }

  async beginReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    const key = w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey);
    const ok = await this.call(() =>
      this.redis.set(key, JSON.stringify({ state: 'pending' }), 'EX', W2_RECEIPT_TTL_SECONDS, 'NX'),
    );
    if (ok === 'OK') return { state: 'pending' as const };
    const existing = await this.getReceipt(organizationId, telefoneCanonico, idempotencyKey);
    return existing ?? { state: 'pending' as const };
  }

  async finalizeReceipt(
    organizationId: string,
    telefoneCanonico: string,
    idempotencyKey: string,
    taskId: string,
  ) {
    await this.call(() =>
      this.redis.set(
        w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey),
        JSON.stringify({ state: 'done', taskId }),
        'EX',
        W2_RECEIPT_TTL_SECONDS,
      ),
    );
  }

  async clearReceipt(organizationId: string, telefoneCanonico: string, idempotencyKey: string) {
    const key = w2ReceiptKey(organizationId, telefoneCanonico, idempotencyKey);
    await this.call(async () => {
      if (this.redis.del) return this.redis.del(key);
      return this.redis.set(key, '', 'EX', 1);
    });
  }
}
