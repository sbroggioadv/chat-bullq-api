import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import Redis from 'ioredis';

/**
 * Health endpoints — exigidos pelo Coolify (HTTP healthcheck) e por probes externos.
 *
 * - GET /health         → liveness (status 200 fixo se o process responder)
 * - GET /health/ready   → readiness (verifica Postgres + Redis; 503 se algo cair)
 *
 * NOTA: o ResponseInterceptor envelopa em { data, meta }. Coolify aceita tanto status
 * 2xx + body qualquer. O body abaixo já passa o gate de "200 OK".
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // Reuse same redis connection params as BullMQ. Lazy-connect so the controller
    // doesn't crash boot if redis is briefly unavailable.
    this.redis = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      password: this.config.get<string>('REDIS_PASSWORD') || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }

  @Get()
  @ApiOperation({ summary: 'Liveness probe — process is up' })
  liveness() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — DB and Redis reachable' })
  async readiness() {
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

    // Postgres ping
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = { ok: true, latencyMs: Date.now() - dbStart };
    } catch (err: any) {
      checks.postgres = { ok: false, error: err.message };
    }

    // Redis ping
    const rStart = Date.now();
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        await this.redis.connect();
      }
      const pong = await this.redis.ping();
      checks.redis = { ok: pong === 'PONG', latencyMs: Date.now() - rStart };
    } catch (err: any) {
      checks.redis = { ok: false, error: err.message };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    if (!allOk) {
      // 503 Service Unavailable — Coolify will mark unhealthy
      const error: any = new Error('Readiness check failed');
      error.status = 503;
      error.response = { status: 'unavailable', checks };
      throw error;
    }

    return { status: 'ready', checks };
  }

  /**
   * S18/W2 — Reports which AI provider env globals are set + how many orgs
   * have org-level credentials configured.
   *
   * Returns ONLY boolean presence + counts. NEVER value or key fragment.
   * Public endpoint (no auth) — useful for external monitoring + the UI to
   * know if ENV_FALLBACK is available before letting user disable
   * org-level credential.
   */
  @Get('llm')
  @ApiOperation({ summary: 'AI provider env presence + org credential counts' })
  async llm() {
    const env = {
      anthropic: Boolean(
        this.config.get<string>('ANTHROPIC_API_KEY') ?? process.env.ANTHROPIC_API_KEY,
      ),
      openai: Boolean(
        this.config.get<string>('OPENAI_API_KEY') ?? process.env.OPENAI_API_KEY,
      ),
      gemini: Boolean(
        this.config.get<string>('GEMINI_API_KEY') ?? process.env.GEMINI_API_KEY,
      ),
    };

    let orgsWithCustomCredentials = 0;
    try {
      const distinct = await this.prisma.organizationCredential.findMany({
        distinct: ['organizationId'],
        select: { organizationId: true },
      });
      orgsWithCustomCredentials = distinct.length;
    } catch (err) {
      // Migration ainda não rodou? Reportamos 0 (graceful).
      orgsWithCustomCredentials = 0;
    }

    return {
      env,
      orgsWithCustomCredentials,
      timestamp: new Date().toISOString(),
    };
  }
}
