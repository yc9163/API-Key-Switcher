/** D1 writes and reads for usage records, daily totals and key health. Every write is best effort:
 * tracking must never break or slow down an API request. */
import { estimateCost } from './pricing';
import { error, json, spendState, spendWindowStart, utcDay, utcHour, type Env, type HealthState } from './shared';
import type { Usage } from './usage';

/** What one /v1/messages call cost, for the usage table. */
export interface Outcome {
  slot: number; organizationId: string | null; status: number; errorType: string | null; stream: boolean;
  completed: boolean; failovers: number; requestId: string | null; app: string | null; client: string; usage: Usage;
}
export interface HealthResult {
  slot: number; state: HealthState; httpStatus: number | null; message: string | null; organizationId: string | null;
  /** From the response headers: rate limits for the checked model, and the workspace the key belongs to. */
  rpm?: number | null; itpm?: number | null; otpm?: number | null; workspaceId?: string | null;
}

/** Adds one request to usage_daily, the per day / key slot / gateway key / app / model totals the dashboard reads. */
export function dailyUpsert(db: D1Database, day: string, slot: number, client: string, app: string | null,
  model: string | null, isError: boolean, u: Usage, cost: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO usage_daily (day, slot, client, app, model, requests, errors, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, est_cost_usd)
      VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT (day, slot, client, app, model) DO UPDATE SET requests = requests + 1, errors = errors + ?6,
        input_tokens = input_tokens + ?7, output_tokens = output_tokens + ?8,
        cache_creation_input_tokens = cache_creation_input_tokens + ?9,
        cache_read_input_tokens = cache_read_input_tokens + ?10, est_cost_usd = est_cost_usd + ?11`)
    .bind(day, slot, client, app ?? '', model ?? '', isError ? 1 : 0, u.input_tokens, u.output_tokens,
      u.cache_creation_input_tokens, u.cache_read_input_tokens, cost);
}

export async function saveUsage(env: Env, startedAt: number, o: Outcome): Promise<void> {
  const db = env.USAGE_DB;
  if (!db) return;
  const u = o.usage;
  const cost = o.status === 200 ? estimateCost(u) : 0;
  try {
    // One transaction: the request row and its daily total land together or not at all.
    await db.batch([
      db.prepare(`INSERT INTO usage (ts, slot, organization_id, model, status, error_type, stream, completed,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, failovers, duration_ms,
          request_id, usage_json, app, client, est_cost_usd)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`)
        .bind(new Date(startedAt).toISOString(), o.slot, o.organizationId, u.model, o.status, o.errorType,
          o.stream ? 1 : 0, o.completed ? 1 : 0, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens,
          u.cache_read_input_tokens, o.failovers, Date.now() - startedAt, o.requestId, u.raw ? JSON.stringify(u.raw) : null,
          o.app, o.client, cost),
      dailyUpsert(db, utcDay(startedAt), o.slot, o.client, o.app, u.model, o.status !== 200, u, cost ?? 0),
      db.prepare(`INSERT INTO usage_hourly (hour, requests, errors, est_cost_usd) VALUES (?1, 1, ?2, ?3)
          ON CONFLICT (hour) DO UPDATE SET requests = requests + 1, errors = errors + ?2, est_cost_usd = est_cost_usd + ?3`)
        .bind(utcHour(startedAt), o.status !== 200 ? 1 : 0, cost ?? 0),
    ]);
    spendState.spent += cost ?? 0;
  } catch {
    // Usage tracking must never break a request.
  }
}

/** Estimated spend in the rolling 24-hour window (current UTC hour and the 23 before it). */
export async function spendInWindow(env: Env, now: number): Promise<number> {
  if (!env.USAGE_DB) return 0;
  const row = await env.USAGE_DB.prepare('SELECT COALESCE(SUM(est_cost_usd), 0) AS spent FROM usage_hourly WHERE hour >= ?1')
    .bind(spendWindowStart(now)).first<{ spent: number }>();
  return row?.spent ?? 0;
}

/** Refreshes this instance's view of the 24-hour spend (used by the spending cap). */
export async function loadSpend(env: Env, now: number): Promise<number> {
  try {
    spendState.spent = await spendInWindow(env, now);
  } catch {
    // Keep the previous figure.
  }
  return spendState.spent;
}

export function healthUpsert(db: D1Database, h: HealthResult, checkedAt: number): D1PreparedStatement {
  // Limits and workspace keep their last known values when a result doesn't carry them (e.g. an error response).
  return db.prepare(`INSERT INTO key_health (slot, state, http_status, message, organization_id, checked_at, rpm, itpm, otpm, workspace_id)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT (slot) DO UPDATE SET state = ?2, http_status = ?3, message = ?4,
        organization_id = COALESCE(?5, organization_id), checked_at = ?6, rpm = COALESCE(?7, rpm),
        itpm = COALESCE(?8, itpm), otpm = COALESCE(?9, otpm), workspace_id = COALESCE(?10, workspace_id)`)
    .bind(h.slot, h.state, h.httpStatus, h.message, h.organizationId, new Date(checkedAt).toISOString(),
      h.rpm ?? null, h.itpm ?? null, h.otpm ?? null, h.workspaceId ?? null);
}

export async function saveHealth(env: Env, h: HealthResult): Promise<void> {
  if (!env.USAGE_DB) return;
  try {
    await healthUpsert(env.USAGE_DB, h, Date.now()).run();
  } catch {
    // Best effort; the next scheduled check rewrites it.
  }
}

export interface HealthRow {
  slot: number; state: HealthState; http_status: number | null; message: string | null;
  organization_id: string | null; checked_at: string;
  rpm: number | null; itpm: number | null; otpm: number | null; workspace_id: string | null;
}
export async function readHealth(env: Env): Promise<Map<number, HealthRow>> {
  if (!env.USAGE_DB) return new Map();
  try {
    const { results } = await env.USAGE_DB.prepare('SELECT * FROM key_health').all<HealthRow>();
    return new Map(results.map((r) => [r.slot, r]));
  } catch {
    return new Map();
  }
}

/** Rows with id > after_id, oldest first, for the local sync script. */
export async function usageRows(env: Env, url: URL): Promise<Response> {
  if (!env.USAGE_DB) return error(503, 'Usage database is not configured.');
  const afterId = Math.max(0, Math.floor(Number(url.searchParams.get('after_id')) || 0));
  const limit = Math.min(5000, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 1000)));
  const { results } = await env.USAGE_DB.prepare('SELECT * FROM usage WHERE id > ?1 ORDER BY id LIMIT ?2')
    .bind(afterId, limit).all();
  return json({ rows: results });
}
