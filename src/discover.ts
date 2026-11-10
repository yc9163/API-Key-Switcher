/** Everything the gateway can learn about its keys from Anthropic's APIs, so nothing has to be kept by hand:
 *  - once a day, per key: the models it can use (Models API) and whether Anthropic's cost report accepts it
 *    (it normally needs an Admin API key; if a key ever works, the dashboard shows Anthropic's exact spend);
 *  - on every key check: rate limits and workspace from the response headers (see dashboard.ts checkKeys);
 *  - every few minutes while the dashboard is open: Anthropic's public status page.
 * Credit balances, promotional credits and renewal dates are not exposed by any Anthropic API. */
import { notify } from './alerts';
import { backends, DAY_MS, upstreamOrigin, utcDay, type Backend, type Env } from './shared';

const DISCOVERY_RELOAD_MS = 60 * 60_000; // each instance re-reads the stored results at most hourly
const DISCOVERY_FETCH_MS = 24 * 3_600_000; // the APIs are asked at most daily
const STATUS_URL = 'https://status.claude.com/api/v2/summary.json';
const STATUS_PAGE = 'https://status.claude.com';
const STATUS_CACHE_MS = 5 * 60_000;
const API_COMPONENT = 'Claude API';

export interface ModelInfo { name: string; created: string | null; maxInput: number | null; maxOutput: number | null; firstSeen: string; keys: number[] }
export interface Discovery {
  checkedAt: string | null;
  firstRun: string | null; // date of the first check: models already there then are not "new"
  models: Record<string, ModelInfo>;
  /** Per key slot: HTTP status of the cost report call, and Anthropic's exact cost since the cycle start if it worked. */
  costReport: Record<number, { status: number; cycleCostUsd: number | null; since: string | null }>;
}
export const discovery: Discovery = { checkedAt: null, firstRun: null, models: {}, costReport: {} };
let nextDiscoveryCheck = 0;

interface ApiModel { id: string; display_name?: string; created_at?: string; max_input_tokens?: number; max_tokens?: number }

async function listModels(env: Env, b: Backend): Promise<ApiModel[] | null> {
  const models: ApiModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const r = await fetch(`${upstreamOrigin(env)}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, {
      headers: { 'x-api-key': b.key, 'anthropic-version': '2023-06-01' },
    });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const body = await r.json() as { data?: ApiModel[]; has_more?: boolean; last_id?: string };
    models.push(...(body.data ?? []));
    if (!body.has_more || !body.last_id) break;
    after = body.last_id;
  }
  return models;
}

/** Anthropic's cost report (legacy Admin API) for this key's organization since `since`; null amount unless 200. */
async function costReport(env: Env, b: Backend, since: string, now: number): Promise<{ status: number; usd: number | null }> {
  try {
    const url = `${upstreamOrigin(env)}/v1/organizations/cost_report?starting_at=${since}T00:00:00Z&ending_at=${utcDay(now + DAY_MS)}T00:00:00Z&limit=31`;
    const r = await fetch(url, { headers: { 'x-api-key': b.key, 'anthropic-version': '2023-06-01' } });
    if (!r.ok) { await r.body?.cancel(); return { status: r.status, usd: null }; }
    const body = await r.json() as { data?: Array<{ results?: Array<{ amount?: string | number }> }> };
    // Amounts are decimal strings in cents.
    const cents = (body.data ?? []).flatMap((d) => d.results ?? []).reduce((a, x) => a + (Number(x.amount) || 0), 0);
    return { status: 200, usd: cents / 100 };
  } catch {
    return { status: 0, usd: null };
  }
}

/** Keeps `discovery` current: re-reads the stored copy hourly; once a day asks the APIs again, notifies about new
 * models, and stores the result. `cycleStartOf` gives each key's current credit-cycle start (for the cost report). */
export async function maybeDiscover(env: Env, now: number, cycleStartOf: (b: Backend) => string): Promise<void> {
  const db = env.USAGE_DB;
  if (!db || now < nextDiscoveryCheck) return;
  nextDiscoveryCheck = now + DISCOVERY_RELOAD_MS;
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE name = 'discovery'`).first<{ value: string }>();
    if (row) Object.assign(discovery, JSON.parse(row.value));
    if (discovery.checkedAt && now - Date.parse(discovery.checkedAt) < DISCOVERY_FETCH_MS) return;
    const keys = backends(env, now);
    const today = utcDay(now);
    const previous = discovery.models;
    const hadModels = Object.keys(previous).length > 0;
    const models: Record<string, ModelInfo> = {};
    const costs: Discovery['costReport'] = {};
    await Promise.all(keys.map(async (b) => {
      const [list, cost] = await Promise.all([listModels(env, b).catch(() => null), costReport(env, b, cycleStartOf(b), now)]);
      costs[b.slot] = { status: cost.status, cycleCostUsd: cost.usd, since: cost.usd === null ? null : cycleStartOf(b) };
      for (const m of list ?? []) {
        const info = models[m.id] ?? {
          name: m.display_name ?? m.id, created: m.created_at ?? null, maxInput: m.max_input_tokens ?? null,
          maxOutput: m.max_tokens ?? null, firstSeen: previous[m.id]?.firstSeen ?? today, keys: [],
        };
        info.keys.push(b.slot);
        models[m.id] = info;
      }
    }));
    for (const info of Object.values(models)) info.keys.sort((a, b) => a - b);
    // If every key failed to list models, keep the previous list rather than wiping it.
    if (Object.keys(models).length === 0) Object.assign(models, previous);
    const added = hadModels ? Object.entries(models).filter(([id]) => !previous[id]) : [];
    Object.assign(discovery, { checkedAt: new Date(now).toISOString(), firstRun: discovery.firstRun ?? today, models, costReport: costs });
    await db.prepare(`INSERT INTO settings (name, value, updated_at) VALUES ('discovery', ?1, ?2)
        ON CONFLICT (name) DO UPDATE SET value = ?1, updated_at = ?2`).bind(JSON.stringify(discovery), discovery.checkedAt).run();
    for (const [id, info] of added) {
      await notify(env, {
        title: `Anthropic 有新模型：${info.name}`,
        message: `${id} 现在可以通过 gateway 使用${info.maxInput ? `（上下文 ${Math.round(info.maxInput / 1000)}K，最大输出 ${Math.round((info.maxOutput ?? 0) / 1000)}K）` : ''}。`,
        priority: 'default', tags: ['sparkles'],
      });
    }
  } catch {
    // Best effort: the previous results stay in use and the next hour tries again.
  }
}

// ---------- Anthropic status page (public, no key) ----------
export interface AnthropicStatus {
  indicator: string; description: string; api: string | null; url: string;
  incidents: Array<{ name: string; status: string; impact: string; url: string | null }>; checkedAt: string;
}
let statusCache: AnthropicStatus | null = null;
let statusCheckedAt = 0;

export async function anthropicStatus(now: number): Promise<AnthropicStatus | null> {
  if (statusCache && now - statusCheckedAt < STATUS_CACHE_MS) return statusCache;
  statusCheckedAt = now; // also on failure, so an outage of the status page doesn't slow every dashboard load
  try {
    const r = await fetch(STATUS_URL, { headers: { accept: 'application/json' } });
    if (!r.ok) { await r.body?.cancel(); return statusCache; }
    const s = await r.json() as {
      status?: { indicator?: string; description?: string };
      components?: Array<{ name: string; status: string; group?: boolean }>;
      incidents?: Array<{ name: string; status: string; impact: string; shortlink?: string; components?: Array<{ name: string }> }>;
    };
    statusCache = {
      indicator: s.status?.indicator ?? 'unknown',
      description: s.status?.description ?? 'Unknown',
      api: s.components?.find((c) => c.name.startsWith(API_COMPONENT))?.status ?? null,
      url: STATUS_PAGE,
      // Unresolved incidents that touch the API (or don't say which component they touch).
      incidents: (s.incidents ?? [])
        .filter((i) => !i.components?.length || i.components.some((c) => c.name.startsWith(API_COMPONENT)))
        .map((i) => ({ name: i.name, status: i.status, impact: i.impact, url: i.shortlink ?? null })),
      checkedAt: new Date(now).toISOString(),
    };
  } catch {
    // Keep the last known status.
  }
  return statusCache;
}
