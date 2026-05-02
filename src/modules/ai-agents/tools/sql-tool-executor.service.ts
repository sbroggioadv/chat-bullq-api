import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiTool } from '@prisma/client';
import { Pool } from 'pg';
import { ToolContext, ToolResult } from './tool.types';

/**
 * Executes user-defined SQL tools against an external Postgres. The DSN comes
 * from process env (referenced by `sqlConnectionRef`), never from the DB —
 * so credentials live with the host config, not the tool record. Queries are
 * always parametrized; the param map says which input/ctx field maps to $1,
 * $2, etc. Read-only is enforced via a verb-blocklist regex (no DELETE,
 * UPDATE, INSERT, DROP, etc) when sqlReadOnly=true (default).
 *
 * One pg.Pool per env-var reference, lazily created and reused, capped at
 * 2 connections so an aggressive agent can't drown the upstream DB.
 */
@Injectable()
export class SqlToolExecutorService implements OnModuleDestroy {
  private readonly logger = new Logger(SqlToolExecutorService.name);
  private readonly pools = new Map<string, Pool>();

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy() {
    for (const pool of this.pools.values()) {
      await pool.end().catch(() => undefined);
    }
  }

  async execute(
    tool: AiTool,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (tool.source !== 'CUSTOM_SQL') {
      throw new Error(`Tool ${tool.name} is not a SQL tool`);
    }
    if (!tool.sqlQuery || !tool.sqlConnectionRef) {
      return {
        output: {
          ok: false,
          error: 'Tool not fully configured (sqlQuery / sqlConnectionRef missing)',
        },
      };
    }

    if (tool.sqlReadOnly && this.hasMutatingVerb(tool.sqlQuery)) {
      return {
        output: {
          ok: false,
          error:
            'Tool is marked read-only mas a query contém verbo de escrita (INSERT/UPDATE/DELETE/etc). Refuse pra proteção.',
        },
      };
    }

    const dsn = this.config.get<string>(tool.sqlConnectionRef);
    if (!dsn) {
      return {
        output: {
          ok: false,
          error: `Env var "${tool.sqlConnectionRef}" não configurada no servidor`,
        },
      };
    }

    const pool = this.getOrCreatePool(tool.sqlConnectionRef, dsn);
    const params = this.buildParams(tool.sqlParamMap, { input, ctx });

    const startedAt = Date.now();
    const client = await pool.connect();
    try {
      // Defense-in-depth: even if read-only check missed something, set the
      // session to read-only on this connection.
      if (tool.sqlReadOnly) {
        await client.query('SET LOCAL TRANSACTION READ ONLY');
      }
      // Postgres-side timeout (catches slow queries that ignore client timeout).
      await client.query(`SET LOCAL statement_timeout = ${tool.timeoutMs ?? 15000}`);

      const result = await client.query({
        text: tool.sqlQuery,
        values: params,
        rowMode: 'array',
      } as any);

      // rowMode: 'array' mode returns rows as arrays + fields metadata.
      // Convert into objects keyed by column name, capped at sqlMaxRows.
      const cols = (result.fields ?? []).map((f: any) => f.name);
      const rows = ((result.rows ?? []) as unknown[][])
        .slice(0, tool.sqlMaxRows ?? 50)
        .map((row) => {
          const obj: Record<string, unknown> = {};
          row.forEach((v, i) => {
            obj[cols[i] ?? `col_${i}`] = this.sanitizeValue(v);
          });
          return obj;
        });

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `[SQL ${tool.name}] ${rows.length} rows in ${durationMs}ms`,
      );

      return {
        output: {
          ok: true,
          rowCount: rows.length,
          truncated:
            (result.rows?.length ?? 0) > (tool.sqlMaxRows ?? 50),
          rows,
        },
      };
    } catch (err: any) {
      this.logger.error(`[SQL ${tool.name}] failed: ${err?.message ?? err}`);
      return {
        output: {
          ok: false,
          error: err?.message ?? String(err),
        },
      };
    } finally {
      client.release();
    }
  }

  // ── helpers ─────────────────────────────────────────────────────

  private getOrCreatePool(refName: string, dsn: string): Pool {
    let pool = this.pools.get(refName);
    if (pool) return pool;
    pool = new Pool({
      connectionString: dsn,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => {
      this.logger.error(`pg pool error [${refName}]: ${err.message}`);
    });
    this.pools.set(refName, pool);
    return pool;
  }

  /**
   * paramMap: [{name:"email", source:"input.email"}, {name:"limit", source:"literal:10"}]
   * Returns positional values matching the order of the array.
   */
  private buildParams(
    raw: unknown,
    scopes: { input: Record<string, unknown>; ctx: ToolContext },
  ): unknown[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => {
      const source = (entry as any)?.source as string;
      if (!source || typeof source !== 'string') return null;
      if (source.startsWith('literal:')) return source.slice('literal:'.length);
      const [scope, ...rest] = source.split('.');
      const path = rest.join('.');
      if (scope === 'input') return this.lookup(scopes.input, path) ?? null;
      if (scope === 'ctx') return this.lookup(scopes.ctx as any, path) ?? null;
      return null;
    });
  }

  private lookup(obj: unknown, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === 'object'
            ? (acc as Record<string, unknown>)[key]
            : undefined,
        obj,
      );
  }

  /**
   * Postgres returns Date/Buffer/etc. The LLM only understands JSON-friendly
   * primitives, so coerce anything weird.
   */
  private sanitizeValue(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') {
      if (value instanceof Date) return value.toISOString();
      if (Buffer.isBuffer(value)) return value.toString('base64');
      try {
        JSON.stringify(value);
        return value;
      } catch {
        return String(value);
      }
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
  }

  private hasMutatingVerb(sql: string): boolean {
    // Strip comments first so we don't false-positive on words inside strings.
    const stripped = sql
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Catch common mutating verbs at statement start or after `;`.
    return /(^|;)\s*(insert|update|delete|drop|alter|truncate|grant|revoke|create|comment\s+on|call|do)\b/i.test(
      stripped,
    );
  }
}
