import { registerAs } from '@nestjs/config';
import type { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').toLowerCase());
}

function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const db = parsed.pathname?.replace('/', '');
  return {
    host: parsed.hostname,
    port: parsed.port
      ? parseInt(parsed.port, 10)
      : parsed.protocol === 'rediss:'
        ? 6380
        : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: db ? parseInt(db, 10) : undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
}

export function buildRedisConnectionOptions(
  config: ConfigService,
  overrides: RedisOptions = {},
): RedisOptions {
  const url = config.get<string>('REDIS_URL') || config.get<string>('redis.url');
  const base: RedisOptions = url
    ? parseRedisUrl(url)
    : {
        host:
          config.get<string>('REDIS_HOST') ||
          config.get<string>('redis.host') ||
          'localhost',
        port:
          parseInt(
            String(
              config.get<string | number>('REDIS_PORT') ??
                config.get<string | number>('redis.port') ??
                '6379',
            ),
            10,
          ) || 6379,
        username:
          config.get<string>('REDIS_USERNAME') ||
          config.get<string>('redis.username') ||
          undefined,
        password:
          config.get<string>('REDIS_PASSWORD') ||
          config.get<string>('redis.password') ||
          undefined,
        db:
          parseInt(
            String(
              config.get<string | number>('REDIS_DB') ??
                config.get<string | number>('redis.db') ??
                '',
            ),
            10,
          ) || undefined,
        tls:
          parseBoolean(config.get<string>('REDIS_TLS')) ||
          parseBoolean(config.get<string>('redis.tls'))
            ? {}
            : undefined,
      };

  return {
    ...base,
    ...overrides,
  };
}

export default registerAs('redis', () => ({
  url: process.env.REDIS_URL || undefined,
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : undefined,
  tls: parseBoolean(process.env.REDIS_TLS),
}));
