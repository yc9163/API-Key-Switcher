/** Key health checks and the hosted usage dashboard (GET /, opened once with a read-only DASHBOARD_KEY link). */
import template from '../report-template.html';
import { alertsEnabled, keyAlert } from './alerts';
import { anthropicStatus, discovery, maybeDiscover } from './discover';
import { estimateCost, maybeUpdatePrices, priceFor, priceState, PRICING_URL } from './pricing';
import {
  addDays, backends, classify, creditBackAt, cycleStart, DAY_MS, error, errorDetails, json, keyOrder, keyState,
  loadOutOfCredit, nextRenewalAfter, sameSecret, setOutOfCredit, spendCap, spendWindowStart, UNUSABLE, upstreamOrigin,
  utcDay, utcHour, type Backend, type Env,
} from './shared';
import { dailyUpsert, healthUpsert, readHealth, spendInWindow, type HealthResult } from './store';
import { usageFromJson } from './usage';

const HEALTH_APP = '(key check)'; // How the checks' own tiny cost shows up in the usage tables.
// Automatic key checks: at most once per KEY_CHECK_INTERVAL_MINUTES (default 60). Real requests that hit a broken
// key report it immediately anyway; these checks catch problems on standby keys.
const checkIntervalMs = (env: Env): number => Math.max(5, Number(env.KEY_CHECK_INTERVAL_MINUTES) || 60) * 60_000;
const ANALYTICS_DAYS = 180;
const HEATMAP_DAYS = 91;
const CHECK_NOW_COOLDOWN_MS = 5 * 60_000; // "Check keys now": at most one real check per 5 minutes, for everyone.
const DATA_CACHE_MS = 60_000;
const COOKIE = 'gw_dash';
let nextCheckDue = 0; // This instance's view of when the key check is next due (ms epoch).

/** Runs the key check when any configured key's last result is older than the check interval. Called on gateway traffic
 * and dashboard loads (the free Workers plan's cron slots are used by other Workers on this account). */
export async function maybeCheckKeys(env: Env, now: number): Promise<void> {
  const db = env.USAGE_DB;
  if (!db || now < nextCheckDue) return;
  const interval = checkIntervalMs(env);
  nextCheckDue = now + interval; // Claim first, so concurrent requests here don't all check.
  const slots = backends(env, now).map((b) => b.slot);
  if (slots.length === 0) return;
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n, MIN(checked_at) AS oldest FROM key_health
        WHERE slot IN (${slots.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...slots).first<{ n: number; oldest: string | null }>();
    const oldest = row?.oldest ? Date.parse(row.oldest) : 0;
    if (row && row.n === slots.length && now - oldest < interval) {
      nextCheckDue = oldest + interval; // Another instance checked recently.
      return;
    }
  } catch {
    return;
  }
  await checkKeys(env, now);
}

/** Sends every key a zero-output request (max_tokens: 0 bills a few input tokens and generates nothing) so a
 * key that is revoked, out of credit or otherwise broken shows up even while it is on standby. */
export async function checkKeys(env: Env, now: number): Promise<void> {
  const db = env.USAGE_DB;
  const keys = backends(env, now);
  if (!db || keys.length === 0) return;
  await loadOutOfCredit(env);
  const model = env.HEALTH_CHECK_MODEL || 'claude-opus-5-5';
  const results = await Promise.all(keys.map(async (b) => {
    let status = 0;
    let text = '';
    let headers: Headers | null = null;
    try {
      const r = await fetch(`${upstreamOrigin(env)}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': b.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 0, messages: [{ role: 'user', content: 'ping' }] }),
      });
      status = r.status;
      headers = r.headers;
      text = await r.text();
    } catch {
      // status stays 0: unreachable
    }
    const state = status === 0 ? 'unreachable' : classify(status, text);
    // Rate limits (for HEALTH_CHECK_MODEL) and workspace come back in the response headers.
    const num = (name: string) => { const v = Number(headers?.get(name)); return Number.isFinite(v) && v > 0 ? v : null; };
    const h: HealthResult = {
      slot: b.slot, state, httpStatus: status || null, message: state === 'ok' ? null : errorDetails(text).message,
      organizationId: headers?.get('anthropic-organization-id') ?? null,
      rpm: num('anthropic-ratelimit-requests-limit'), itpm: num('anthropic-ratelimit-input-tokens-limit'),
      otpm: num('anthropic-ratelimit-output-tokens-limit'), workspaceId: headers?.get('anthropic-workspace-id') ?? null,
    };
    return { b, text, h };
  }));
  const statements: D1PreparedStatement[] = [];
  const creditReturned = new Set<number>();
  for (const { b, text, h } of results) {
    if (h.state === 'out_of_credit') await setOutOfCredit(env, b.slot, creditBackAt(b, now));
    else if (h.state === 'ok' && keyState.outOfCredit.has(b.slot)) {
      creditReturned.add(b.slot);
      await setOutOfCredit(env, b.slot, null);
    }
    statements.push(healthUpsert(db, h, now));
    if (h.state === 'ok') {
      const usage = usageFromJson(text, model);
      statements.push(dailyUpsert(db, utcDay(now), b.slot, '', HEALTH_APP, usage.model, false, usage, estimateCost(usage) ?? 0));
    }
  }
  try {
    await db.batch(statements);
  } catch {
    // The next scheduled check tries again.
  }
  // Phone notifications for keys that stopped working or came back (warnings like rate limits don't notify).
  await Promise.all(results.map(({ b, h }) => {
    if (UNUSABLE.has(h.state)) return keyAlert(env, b.slot, true, describeHealth(h, b));
    if (h.state === 'ok') return keyAlert(env, b.slot, false, creditReturned.has(b.slot) ? creditReturnHint(b, now) : '');
    return Promise.resolve();
  }));
}

/** Renewal days can't be read from any Anthropic API, so when a key's credit comes back the day is compared with
 * its configured renewal day (UTC): a mismatch suggests the renewal day changed or was never set. */
export function creditReturnHint(b: Backend, now: number): string {
  const day = new Date(now).getUTCDate();
  const today = utcDay(now);
  if (!b.expiry) return `额度在 ${today}（UTC）恢复。可以把这个 key 的续期日设为每月 ${day} 号。`;
  if (b.expiry.daysLeft === 0 || b.expiry.day === day) return ''; // back on its renewal day, as expected
  return `额度在 ${today}（UTC）恢复，但续期日设的是每月 ${b.expiry.day} 号。如果每个月都是这样，续期日可能该改成 ${day} 号。`;
}

/** One-line reason for a phone notification. */
export function describeHealth(h: HealthResult, b: Backend): string {
  const renew = b.expiry ? `，${b.expiry.date} 续期后恢复` : '';
  switch (h.state) {
    case 'out_of_credit': return `额度用完了${renew}`;
    case 'invalid_key': return `API key 无效或已被撤销（HTTP ${h.httpStatus}）`;
    case 'billing': return `账单有问题（HTTP ${h.httpStatus}）`;
    case 'no_permission': return `没有权限（HTTP ${h.httpStatus}）`;
    default: return h.message ?? h.state;
  }
}

interface DailyRow {
  day: string; slot: number; client: string; app: string; model: string; requests: number; errors: number; input_tokens: number;
  output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; est_cost_usd: number;
}

// Messages API requests-per-minute for the 5.5 models by usage tier, with each tier's monthly spend cap
// (platform.claude.com/docs/en/api/rate-limits): names an organization's tier from its rate-limit headers.
const TIERS_55 = [
  { name: 'Start', rpm: 4_000, spendCapUsd: 500 },
  { name: 'Build', rpm: 10_000, spendCapUsd: 1_000 },
  { name: 'Scale', rpm: 13_000, spendCapUsd: 200_000 },
];
function tierOf(model: string, rpm: number | null): { name: string; spendCapUsd: number | null } | null {
  if (!rpm || !/^claude-(opus|sonnet|haiku)-5-5/.test(model)) return null;
  const tier = TIERS_55.find((t) => t.rpm === rpm);
  return tier ? { name: tier.name, spendCapUsd: tier.spendCapUsd } : { name: rpm < 4_000 ? 'Evaluation' : 'Custom', spendCapUsd: null };
}

/** Each key's current credit-cycle start (for Anthropic's cost report): its renewal day, else the last 30 days. */
export const cycleStartFor = (now: number) => (b: Backend): string =>
  b.expiry ? cycleStart(utcDay(now), b.expiry.day) : utcDay(now - 30 * DAY_MS);

/** Everything report-template.html renders, computed from the daily totals (cheap to read on every refresh). */
export async function dashboardData(env: Env, now: number) {
  const db = env.USAGE_DB!;
  const today = utcDay(now);
  const credit = Number(env.MONTHLY_CREDIT_USD) || 200;
  const keys = backends(env, now);
  await loadOutOfCredit(env);
  keyState.loadedAt = now;
  const [dailyRes, errorsRes, firstRes, hourlyRes] = await db.batch([
    // 180 days: the longest range (90 days) plus the period before it, for comparisons.
    db.prepare('SELECT * FROM usage_daily WHERE day >= ?1').bind(addDays(today, -(ANALYTICS_DAYS - 1))),
    db.prepare('SELECT ts, slot, client, app, model, status, error_type FROM usage WHERE status != 200 ORDER BY id DESC LIMIT 15'),
    db.prepare('SELECT MIN(day) AS first FROM usage_daily'),
    // Hourly totals for the activity heatmap (longest range, 90 days) and the rolling 24-hour spend.
    db.prepare('SELECT hour, requests, errors, est_cost_usd FROM usage_hourly WHERE hour >= ?1').bind(utcHour(now - HEATMAP_DAYS * DAY_MS)),
  ]);
  const rows = dailyRes.results as unknown as DailyRow[];
  const hourly = hourlyRes.results as Array<{ hour: string; requests: number; errors: number; est_cost_usd: number }>;
  const windowFrom = spendWindowStart(now);
  const spent24h = hourly.filter((h) => h.hour >= windowFrom).reduce((a, h) => a + h.est_cost_usd, 0);
  const health = await readHealth(env);
  const order = keyOrder(keys, now).map((b) => b.slot);
  const sum = (filter: (r: DailyRow) => boolean) => rows.filter(filter).reduce((a, r) => a + r.est_cost_usd, 0);

  const checkModel = env.HEALTH_CHECK_MODEL || 'claude-opus-5-5';
  const status = await anthropicStatus(now);
  const keyData = keys.map((b) => {
    const renewDay = b.expiry?.day ?? null;
    const start = renewDay ? cycleStart(today, renewDay) : null;
    const next = renewDay && start ? nextRenewalAfter(start, renewDay) : null;
    const h = health.get(b.slot);
    const creditBack = keyState.outOfCredit.get(b.slot) ?? 0;
    return {
      slot: b.slot,
      priority: order.indexOf(b.slot) + 1,
      renewDay,
      cycleStart: start,
      nextRenewal: next,
      daysLeft: next ? Math.round((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) : null,
      credit,
      cycleToDate: start ? sum((r) => r.slot === b.slot && r.day >= start) : 0,
      today: sum((r) => r.slot === b.slot && r.day === today),
      outOfCreditUntil: creditBack > now ? new Date(creditBack).toISOString() : null,
      coolingDown: false,
      health: h ? { state: h.state, httpStatus: h.http_status, message: h.message, checkedAt: h.checked_at } : null,
      orgId: h?.organization_id?.slice(0, 8) ?? null, // enough to tell organizations apart on a public page
      // From the key check's response headers: this organization's limits for HEALTH_CHECK_MODEL, and its tier.
      limits: h?.rpm ? { model: checkModel, rpm: h.rpm, itpm: h.itpm, otpm: h.otpm } : null,
      tier: tierOf(checkModel, h?.rpm ?? null),
      // Anthropic's own figure for this cycle, only if the cost report ever accepts this key (normally Admin-only).
      exactCycleCost: start && discovery.costReport[b.slot]?.since === start ? discovery.costReport[b.slot].cycleCostUsd : null,
    };
  });

  // Base prices of the models seen, so the page can split cost by token type and work out cache savings.
  const prices: Record<string, number[]> = {};
  for (const r of rows) {
    const p = r.model ? priceFor(r.model) : null;
    if (p) prices[r.model] = p;
  }

  // Spending pace: average per day over the last 7 days (or since the first record), over at least one day.
  const first = (firstRes.results[0] as { first: string | null } | undefined)?.first ?? today;
  const windowStart = first > addDays(today, -6) ? first : addDays(today, -6);
  const burnPerDay = sum((r) => r.day >= windowStart) / Math.max(1, (now - Date.parse(`${windowStart}T00:00:00Z`)) / DAY_MS);

  return {
    live: true,
    generatedAt: new Date(now).toISOString(),
    todayUtc: today,
    dayFractionElapsed: (now - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
    burnPerDay,
    keys: keyData,
    // One compact row per day / key slot / gateway key / app / model; the page groups and filters these.
    rowFields: ['day', 'slot', 'client', 'app', 'model', 'requests', 'errors', 'input', 'output', 'cacheWrite', 'cacheRead', 'cost'],
    rows: rows.map((r) => [r.day, r.slot, r.client, r.app, r.model, r.requests, r.errors, r.input_tokens, r.output_tokens,
      r.cache_creation_input_tokens, r.cache_read_input_tokens, Math.round(r.est_cost_usd * 1e6) / 1e6]),
    prices,
    // One row per UTC hour with usage: [hour 'YYYY-MM-DDTHH', requests, cost]; the page maps it to local time.
    hours: hourly.map((h) => [h.hour, h.requests, Math.round(h.est_cost_usd * 1e6) / 1e6]),
    cap: { limit: spendCap(env), spent24h },
    alertsEnabled: alertsEnabled(env),
    // Where cost estimates come from: Anthropic's pricing page (read daily) or the built-in table.
    pricing: { source: priceState.table ? PRICING_URL : 'built-in', fetchedAt: priceState.fetchedAt, error: priceState.error },
    // Found through Anthropic's APIs (src/discover.ts): models each key can use, cost-report access, service status.
    models: Object.entries(discovery.models)
      .map(([id, m]) => ({ id, name: m.name, created: m.created, maxInput: m.maxInput, maxOutput: m.maxOutput,
        firstSeen: m.firstSeen, keys: m.keys, price: priceFor(id) }))
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '') || a.id.localeCompare(b.id)),
    discoveredAt: discovery.checkedAt,
    discoveredSince: discovery.firstRun,
    costReport: Object.fromEntries(Object.entries(discovery.costReport).map(([slot, c]) => [slot, c.status])),
    anthropicStatus: status,
    checkCooldownMinutes: CHECK_NOW_COOLDOWN_MS / 60_000,
    checkIntervalMinutes: checkIntervalMs(env) / 60_000,
    errors: (errorsRes.results as Array<{ ts: string; slot: number; client: string | null; app: string | null; model: string | null; status: number; error_type: string | null }>)
      .map((e) => ({ time: e.ts, slot: e.slot, client: e.client, app: e.app, model: e.model, status: e.status, errorType: e.error_type })),
  };
}

// The data is public, so any page may read it; this lets the local usage\report.html show live numbers.
const DATA_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow',
  'access-control-allow-origin': '*' };
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow', // keep the public dashboard out of search engines
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const SIGN_IN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude credit usage</title>
<body style="font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:15vh auto;padding:0 24px">
<h1 style="font-size:20px">This dashboard needs its private link</h1>
<p>Open the link saved in <code>DASHBOARD_LINK.txt</code> in the gateway folder on your PC. After that, this browser stays signed in.</p></body>`;

/** Redirects to the dashboard at /, keeping any view parameters but dropping a key from the address bar; in
 * private mode it also signs the browser in with an HttpOnly cookie for the whole site. */
function toDashboard(url: URL, dashboardKey?: string): Response {
  const params = new URLSearchParams(url.search);
  params.delete('key');
  const query = params.toString();
  const headers: Record<string, string> = {
    location: query ? `/?${query}` : '/',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
  if (dashboardKey) {
    headers['set-cookie'] = `${COOKIE}=${encodeURIComponent(dashboardKey)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
  }
  return new Response(null, { status: 302, headers });
}

// Per instance: the last /dashboard/data body, reused for a minute so that reloading (or a crowd of visitors)
// doesn't read the database on every request, and the newest key-check time it contained.
let dataCache: { body: string; at: number; latestCheck: number } | null = null;

async function dataResponse(env: Env, now: number, fresh: boolean): Promise<Response> {
  if (fresh || !dataCache || now - dataCache.at >= DATA_CACHE_MS) {
    await maybeCheckKeys(env, now); // Opening the page after a quiet spell shows fresh key status.
    await maybeUpdatePrices(env, now);
    await maybeDiscover(env, now, cycleStartFor(now));
    const data = await dashboardData(env, now);
    const latestCheck = Math.max(0, ...data.keys.map((k) => (k.health ? Date.parse(k.health.checkedAt) : 0)));
    dataCache = { body: JSON.stringify(data), at: now, latestCheck };
  }
  return new Response(dataCache.body, { headers: DATA_HEADERS });
}

/** The dashboard page (/ and the older /dashboard) and its data (/dashboard/data, /dashboard/check). Public unless
 * the DASHBOARD_KEY secret is set: then the link carries ?key=<DASHBOARD_KEY> once and an HttpOnly cookie signs
 * the browser in. Either way it only reads usage and key status; API requests always need a gateway key. */
export async function handleDashboard(request: Request, env: Env, url: URL): Promise<Response> {
  const dashboardKey = env.DASHBOARD_KEY?.trim();
  const isPage = url.pathname === '/' || url.pathname === '/dashboard';
  if (dashboardKey) {
    const linkKey = url.searchParams.get('key');
    if (isPage && linkKey !== null) {
      if (!sameSecret(linkKey.trim(), dashboardKey)) return new Response(SIGN_IN_PAGE, { status: 401, headers: PAGE_HEADERS });
      return toDashboard(url, dashboardKey);
    }
    let provided = request.headers.get('x-api-key') ?? '';
    const cookie = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`))?.[1];
    if (cookie) {
      try { provided = decodeURIComponent(cookie); } catch { provided = ''; }
    }
    if (!provided || !sameSecret(provided.trim(), dashboardKey)) {
      return isPage ? new Response(SIGN_IN_PAGE, { status: 401, headers: PAGE_HEADERS }) : error(401, 'Dashboard key required.');
    }
  } else if (isPage && url.searchParams.has('key')) {
    return toDashboard(url); // An old private link: the dashboard is public now.
  }
  if (!env.USAGE_DB) return error(503, 'Usage database is not configured.');
  // The dashboard used to live at /dashboard: send such links and bookmarks to /.
  if (url.pathname === '/dashboard' && request.method === 'GET') return toDashboard(url, dashboardKey);
  if (url.pathname === '/' && request.method === 'GET') return new Response(template, { headers: PAGE_HEADERS });
  if (url.pathname === '/dashboard/data' && request.method === 'GET') return dataResponse(env, Date.now(), false);
  if (url.pathname === '/dashboard/check' && request.method === 'POST') {
    // "Check keys now", shared by everyone: at most one real check per cooldown, however often it is pressed.
    // The cooldown is judged from this instance's cached data first, so repeated presses don't even read the database.
    const now = Date.now();
    if (dataCache && now - dataCache.latestCheck < CHECK_NOW_COOLDOWN_MS) return dataResponse(env, now, false);
    const latest = Math.max(0, ...[...(await readHealth(env)).values()].map((h) => Date.parse(h.checked_at)));
    if (now - latest < CHECK_NOW_COOLDOWN_MS) return dataResponse(env, now, true);
    await checkKeys(env, now);
    return dataResponse(env, now, true);
  }
  return error(404, 'Not found.');
}
