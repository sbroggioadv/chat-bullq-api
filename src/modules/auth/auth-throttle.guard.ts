import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';

/**
 * Lightweight in-memory sliding-window rate limiter for /auth/login.
 *
 * Rationale (S16): protege contra brute-force/credential stuffing. Replica o padrão
 * do `WebhookThrottleGuard` para evitar adicionar dependência nova (@nestjs/throttler)
 * em meio ao cutover. Pra prod multi-instance, migrar pra Redis-backed counter.
 *
 * Limite: 10 hits / 60s por IP. Header `X-Forwarded-For` respeitado (atrás de proxy).
 */
@Injectable()
export class AuthThrottleGuard implements CanActivate {
  private readonly logger = new Logger(AuthThrottleGuard.name);

  private static readonly WINDOW_MS = 60_000;
  private static readonly MAX_HITS = 10;

  private readonly hits = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const key = this.resolveKey(req);
    const now = Date.now();
    const windowStart = now - AuthThrottleGuard.WINDOW_MS;

    const recent = (this.hits.get(key) || []).filter((ts) => ts >= windowStart);
    recent.push(now);
    this.hits.set(key, recent);

    // Garbage collect occasionally — drop keys with no recent activity.
    if (this.hits.size > 5000) {
      for (const [k, arr] of this.hits.entries()) {
        if (arr.every((ts) => ts < windowStart)) this.hits.delete(k);
      }
    }

    if (recent.length > AuthThrottleGuard.MAX_HITS) {
      this.logger.warn(
        `Throttled /auth from ${key} (${recent.length} hits/60s)`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many auth attempts. Try again later.',
          retryAfterMs: AuthThrottleGuard.WINDOW_MS,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private resolveKey(req: any): string {
    const xff = req.headers?.['x-forwarded-for'];
    const ip =
      (Array.isArray(xff) ? xff[0] : (xff || '').split(',')[0].trim()) ||
      req.ip ||
      req.socket?.remoteAddress ||
      'unknown';
    // Per-IP key. Could be combined with email for stricter per-account lockout.
    return `auth:${ip}`;
  }
}
