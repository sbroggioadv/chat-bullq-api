import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';

/**
 * In-memory sliding-window rate limiter para POST /credentials/:provider/test.
 *
 * Espelha o padrão de `AuthThrottleGuard` (in-memory, single-instance).
 * Pra prod multi-instance migrar pra Redis. Por agora limit per (orgId, ip)
 * é suficiente — abuse vetor é "spam contra APIs externas" do provider, não
 * brute-force interno.
 *
 * Limite: 10 hits / 60s por (org, ip).
 */
@Injectable()
export class CredentialTestThrottleGuard implements CanActivate {
  private readonly logger = new Logger(CredentialTestThrottleGuard.name);

  private static readonly WINDOW_MS = 60_000;
  private static readonly MAX_HITS = 10;

  private readonly hits = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const orgId = req.organizationId ?? req.user?.organizationId ?? 'unknown';
    const xff = req.headers?.['x-forwarded-for'];
    const ip =
      (Array.isArray(xff) ? xff[0] : (xff || '').split(',')[0].trim()) ||
      req.ip ||
      req.socket?.remoteAddress ||
      'unknown';
    const key = `cred-test:${orgId}:${ip}`;
    const now = Date.now();
    const windowStart = now - CredentialTestThrottleGuard.WINDOW_MS;

    const recent = (this.hits.get(key) || []).filter((ts) => ts >= windowStart);
    recent.push(now);
    this.hits.set(key, recent);

    if (this.hits.size > 5000) {
      for (const [k, arr] of this.hits.entries()) {
        if (arr.every((ts) => ts < windowStart)) this.hits.delete(k);
      }
    }

    if (recent.length > CredentialTestThrottleGuard.MAX_HITS) {
      this.logger.warn(`Throttled credential test from ${key} (${recent.length}/60s)`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many credential tests. Try again in a minute.',
          retryAfterMs: CredentialTestThrottleGuard.WINDOW_MS,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
