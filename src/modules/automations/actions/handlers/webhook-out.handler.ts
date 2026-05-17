import { Injectable, Logger } from '@nestjs/common';
import {
  ActionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../action.types';

interface WebhookOutParams {
  // Destination URL. Validated against WEBHOOK_OUT_ALLOWED_HOSTS env var
  // (comma-separated hostnames) at execute time. Defense against a stolen
  // automation rule being weaponized to exfiltrate data to attacker domains.
  url: string;
  // Optional headers. Common case: { "X-Webhook-Token": "..." }. Do not
  // put secrets in plaintext params for production — the params are stored
  // verbatim in the rule row. For now we accept inline tokens since this
  // is internal-only (n8n callbacks); harden via env-var lookup later.
  headers?: Record<string, string>;
  // Optional body override. If absent, handler builds a normalized
  // envelope from the event payload (recommended — keeps n8n contract
  // stable across triggers).
  payloadOverride?: Record<string, unknown>;
  // Request timeout. Default 10s — n8n webhook responses typically
  // <500ms so 10s catches network-level stalls without slowing the run.
  timeoutMs?: number;
}

/**
 * webhook_out — fire-and-forget HTTP POST to an external system.
 *
 * Purpose: bridge bullq2 automation events to integration platforms
 * (n8n, Zapier, Make) without coupling bullq2 to any specific target
 * system. The handler ships a normalized envelope; the receiver decides
 * what to do (create Hoppe task, push to ERP, log to spreadsheet, etc).
 *
 * continueOnError default = true. Communication actions should never
 * block state-changing actions downstream — if the webhook is unreachable
 * we retry and log, but the run keeps going.
 */
@Injectable()
export class WebhookOutHandler implements ActionHandler {
  private readonly logger = new Logger(WebhookOutHandler.name);

  readonly type = 'webhook_out' as const;
  readonly continueOnErrorDefault = true;

  // Per-host circuit breaker — same pattern as send-message. Three
  // failures in 60s opens the breaker for 30s, then a single probe.
  private readonly failures = new Map<string, number[]>();
  private readonly openUntil = new Map<string, number>();
  private static readonly FAIL_WINDOW_MS = 60_000;
  private static readonly FAIL_THRESHOLD = 3;
  private static readonly COOLDOWN_MS = 30_000;
  private static readonly DEFAULT_TIMEOUT_MS = 10_000;
  private static readonly MAX_RETRIES = 3;

  validateParams(params: Record<string, unknown>): void {
    if (!params.url || typeof params.url !== 'string') {
      throw new Error('webhook_out: "url" is required (string)');
    }
    let parsed: URL;
    try {
      parsed = new URL(params.url as string);
    } catch {
      throw new Error('webhook_out: "url" is not a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('webhook_out: "url" must be http(s)');
    }
    if (
      params.headers !== undefined &&
      (typeof params.headers !== 'object' ||
        params.headers === null ||
        Array.isArray(params.headers))
    ) {
      throw new Error('webhook_out: "headers" must be an object');
    }
    if (
      params.payloadOverride !== undefined &&
      (typeof params.payloadOverride !== 'object' ||
        params.payloadOverride === null ||
        Array.isArray(params.payloadOverride))
    ) {
      throw new Error('webhook_out: "payloadOverride" must be an object');
    }
    if (
      params.timeoutMs !== undefined &&
      (typeof params.timeoutMs !== 'number' ||
        params.timeoutMs < 100 ||
        params.timeoutMs > 60_000)
    ) {
      throw new Error('webhook_out: "timeoutMs" must be 100..60000');
    }
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult> {
    const p = params as unknown as WebhookOutParams;
    const url = new URL(p.url);

    // Allowlist check — env-var driven so ops can add hosts without code
    // change. Empty allowlist = deny all (safe default in dev/test).
    const allowed = (process.env.WEBHOOK_OUT_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(url.hostname.toLowerCase())) {
      return {
        ok: false,
        errorCode: 'host_not_allowed',
        errorMessage: `host "${url.hostname}" not in WEBHOOK_OUT_ALLOWED_HOSTS`,
      };
    }

    // Circuit breaker per host — protect both the receiver and ourselves
    // from runaway retries when n8n is wedged.
    const breakerKey = url.hostname;
    const openUntil = this.openUntil.get(breakerKey) ?? 0;
    if (Date.now() < openUntil) {
      return {
        ok: false,
        errorCode: 'circuit_open',
        errorMessage: `host ${breakerKey} in cooldown — provider failing`,
      };
    }

    const body = p.payloadOverride ?? this.buildEnvelope(ctx);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Idempotency-Key: receiver dedups retries by traceId. n8n's webhook
      // node doesn't honor this by default but downstream nodes can read
      // the header and skip side effects on dup.
      'Idempotency-Key': ctx.traceId,
      'X-Bullq-Trace-Id': ctx.traceId,
      'X-Bullq-Cascade-Depth': String(ctx.cascadeDepth),
      ...(p.headers ?? {}),
    };
    const timeoutMs = p.timeoutMs ?? WebhookOutHandler.DEFAULT_TIMEOUT_MS;

    let lastErr: string | undefined;
    let lastStatus: number | undefined;
    for (let attempt = 1; attempt <= WebhookOutHandler.MAX_RETRIES; attempt++) {
      const result = await this.fireOnce(url.toString(), body, headers, timeoutMs);
      if (result.ok) {
        // Reset breaker on first success — even an attempt-3 success.
        this.failures.delete(breakerKey);
        return {
          ok: true,
          output: {
            status: result.status,
            attempt,
            host: breakerKey,
          },
        };
      }
      lastErr = result.errorMessage;
      lastStatus = result.status;
      // Don't retry 4xx (except 408/425/429) — bad request stays bad.
      if (
        result.status !== undefined &&
        result.status >= 400 &&
        result.status < 500 &&
        ![408, 425, 429].includes(result.status)
      ) {
        break;
      }
      // Exponential backoff: 500ms, 1500ms (skipped after last attempt)
      if (attempt < WebhookOutHandler.MAX_RETRIES) {
        const delay = 500 * Math.pow(3, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    this.recordFailure(breakerKey);
    this.logger.warn(
      `webhook_out failed: ${breakerKey} status=${lastStatus ?? 'n/a'} err="${lastErr}" traceId=${ctx.traceId}`,
    );
    return {
      ok: false,
      errorCode: lastStatus !== undefined ? 'external_error' : 'network_error',
      errorMessage: lastErr ?? 'unknown failure',
      output: { host: breakerKey, lastStatus, attempts: WebhookOutHandler.MAX_RETRIES },
    };
  }

  private buildEnvelope(ctx: ActionContext): Record<string, unknown> {
    const { payload, traceId, organizationId, actorId } = ctx;
    return {
      schema: 'bullq.webhook_out.v1',
      ts: new Date().toISOString(),
      traceId,
      organizationId,
      actorId,
      // Spread the trigger payload verbatim so the receiver gets every
      // field (contactId, conversationId, channelId, plus trigger-specific
      // fields like body/tagId/etc). Receivers should pattern-match on
      // presence of fields, not assume a fixed shape.
      event: payload,
    };
  }

  private async fireOnce(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ ok: boolean; status?: number; errorMessage?: string }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) {
        return { ok: true, status: res.status };
      }
      // Read short body for log context (max 256 chars)
      let text = '';
      try {
        text = (await res.text()).slice(0, 256);
      } catch {
        // ignore — status is enough
      }
      return {
        ok: false,
        status: res.status,
        errorMessage: `HTTP ${res.status} ${res.statusText} ${text}`.trim(),
      };
    } catch (err) {
      const msg = (err as Error).message;
      return { ok: false, errorMessage: msg };
    } finally {
      clearTimeout(t);
    }
  }

  private recordFailure(key: string) {
    const now = Date.now();
    const recent = (this.failures.get(key) ?? []).filter(
      (t) => now - t < WebhookOutHandler.FAIL_WINDOW_MS,
    );
    recent.push(now);
    this.failures.set(key, recent);
    if (recent.length >= WebhookOutHandler.FAIL_THRESHOLD) {
      this.openUntil.set(key, now + WebhookOutHandler.COOLDOWN_MS);
      this.failures.delete(key);
      this.logger.error(
        `webhook_out circuit OPEN for host ${key} — cooldown ${WebhookOutHandler.COOLDOWN_MS}ms`,
      );
    }
  }
}
