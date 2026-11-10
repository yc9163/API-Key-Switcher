/** Configuration, key selection and shared key state used by the proxy, the health checks and the dashboard. */
export interface Env {
  // Keys callers authenticate with: GATEWAY_KEY (named "main") plus any number of GATEWAY_KEY_<NAME> secrets.
  GATEWAY_KEY?: string;
  // Read-only key for the dashboard link; it cannot send API requests.
  DASHBOARD_KEY?: string;
  ANTHROPIC_KEY_1?: string;
  ANTHROPIC_KEY_2?: string;
  ANTHROPIC_KEY_3?: string;
  ANTHROPIC_KEY_4?: string;
  ANTHROPIC_KEY_5?: string;
  ANTHROPIC_KEY_6?: string;
  // Day of the month (1-31, UTC) each slot's monthly credit expires; "0" or unset = unknown. Set in wrangler.jsonc
  // as strings: numeric vars stop .dev.vars secrets from loading under `wrangler dev`.
  CREDIT_EXPIRY_DAY_1?: string;
  CREDIT_EXPIRY_DAY_2?: string;
  CREDIT_EXPIRY_DAY_3?: string;
  CREDIT_EXPIRY_DAY_4?: string;
  CREDIT_EXPIRY_DAY_5?: string;
  CREDIT_EXPIRY_DAY_6?: string;
  MONTHLY_CREDIT_USD?: string; // Credit each key receives per billing cycle (Max 20x: 200).
  HEALTH_CHECK_MODEL?: string; // Model the scheduled key check sends its zero-output request to.
  KEY_CHECK_INTERVAL_MINUTES?: string; // Automatic key checks at most this often (default 60, minimum 5).
  DAILY_SPEND_CAP_USD?: string; // Most the gateway spends in any rolling 24 hours; "0" or unset = no cap.
  PUBLIC_URL?: string; // This Worker's address, for links in phone notifications.
  NTFY_TOPIC?: string; // Secret ntfy.sh topic for phone notifications; unset = no notifications.
  NTFY_SERVER?: string; // ntfy server (default https://ntfy.sh).
  USAGE_DB?: D1Database;
  UPSTREAM_ORIGIN?: string; // Local testing only (a mock Anthropic API); unset in production.
}
export interface Expiry { day: number; date: string; daysLeft: number }
export interface Backend { slot: number; key: string; expiry: Expiry | null }

export const SLOTS = [1, 2, 3, 4, 5, 6];
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
// Anthropic's exact out-of-credit message: "Your credit balance is too low to access the Anthropic API."
export const OUT_OF_CREDIT = /credit balance is too low/i;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value, null, 2), { status, headers: JSON_HEADERS });
export const error = (status: number, message: string): Response =>
  json({ type: 'error', error: { type: 'gateway_error', message } }, status);

export function sameSecret(received: string, expected: string): boolean {
  // No short-circuit on matching prefix; compare using full maximum length.
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Gateway keys callers may use: GATEWAY_KEY as "main", each GATEWAY_KEY_<NAME> secret as "<name>".
 * Add one with `npx wrangler secret put GATEWAY_KEY_<NAME>`; remove it with `wrangler secret delete`. */
export function gatewayKeys(env: Env): { name: string; key: string }[] {
  const out: { name: string; key: string }[] = [];
  for (const [binding, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    const match = binding.match(/^GATEWAY_KEY(?:_([A-Za-z0-9_]+))?$/);
    // Trim: secrets piped in from a shell often carry a trailing newline.
    const key = typeof value === 'string' ? value.trim() : '';
    if (match && key) out.push({ name: match[1] ? match[1].toLowerCase() : 'main', key });
  }
  return out;
}

export const upstreamOrigin = (env: Env): string => env.UPSTREAM_ORIGIN || ANTHROPIC_ORIGIN;
export const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const utcHour = (t: number): string => new Date(t).toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
/** Start of the rolling 24-hour spending window: the current UTC hour and the 23 before it. */
export const spendWindowStart = (now: number): string => utcHour(now - 23 * HOUR_MS);
export const spendCap = (env: Env): number => Math.max(0, Number(env.DAILY_SPEND_CAP_USD) || 0);
// Per Worker instance: estimated spend in the rolling 24-hour window, refreshed from usage_hourly at most once a
// minute and increased locally as this instance records requests. A runaway guard, not an exact meter.
export const spendState = { spent: 0, loadedAt: 0 };
export const addDays = (day: string, n: number): string => utcDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
const lastDayOf = (year: number, month0: number): number => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** Next date (UTC, today included) the given day of the month falls on; short months clamp to their last day. */
export function nextExpiry(day: number, now: number): Expiry | null {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const today = new Date(now);
  const y = today.getUTCFullYear(), m = today.getUTCMonth(), d = today.getUTCDate();
  const dayIn = (month: number) => Math.min(day, new Date(Date.UTC(y, month + 1, 0)).getUTCDate());
  const target = dayIn(m) >= d ? Date.UTC(y, m, dayIn(m)) : Date.UTC(y, m + 1, dayIn(m + 1));
  return { day, date: utcDay(target), daysLeft: Math.round((target - Date.UTC(y, m, d)) / DAY_MS) };
}

/** First day of the credit cycle containing `day`: the latest renewal day on or before it. */
export function cycleStart(day: string, renewDay: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const thisMonth = Math.min(renewDay, lastDayOf(y, m - 1));
  if (d >= thisMonth) return utcDay(Date.UTC(y, m - 1, thisMonth));
  const prev = new Date(Date.UTC(y, m - 2, 1));
  return utcDay(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), Math.min(renewDay, lastDayOf(prev.getUTCFullYear(), prev.getUTCMonth()))));
}

/** The renewal one month after `start` (a cycle start), clamped to short months. */
export function nextRenewalAfter(start: string, renewDay: number): string {
  const [y, m] = start.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1)); // first of the following month
  return utcDay(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), Math.min(renewDay, lastDayOf(next.getUTCFullYear(), next.getUTCMonth()))));
}

export function backends(env: Env, now: number): Backend[] {
  const vars = env as unknown as Record<string, string | undefined>;
  return SLOTS
    .map((slot) => ({
      slot,
      key: String(vars[`ANTHROPIC_KEY_${slot}`] ?? '').trim(),
      expiry: nextExpiry(Number(vars[`CREDIT_EXPIRY_DAY_${slot}`] ?? 0), now),
    }))
    .filter(({ key }) => key.length > 0);
}

// Best effort, per Worker isolate: slot -> time (ms epoch) until which a recently failed key is tried last.
export const cooldownUntil = new Map<number, number>();
// Shared by every Worker instance through the key_state table: slot -> time (ms epoch) the key's credit is
// expected back. Refreshed in the background at most once a minute, so requests never wait on it.
export const keyState = { outOfCredit: new Map<number, number>(), loadedAt: 0 };

/** Credit that expires soonest is spent first; keys cooling down or out of credit go last; ties go to the lowest
 * slot. The order is deliberately stable: prompt caches belong to one organization, so sending every request to
 * the same key (until it fails) keeps cache hits, where spreading requests across keys would rebuild the cache. */
export function keyOrder(keys: Backend[], now: number): Backend[] {
  const until = (b: Backend) => Math.max(cooldownUntil.get(b.slot) ?? 0, keyState.outOfCredit.get(b.slot) ?? 0, now);
  const daysLeft = (b: Backend) => b.expiry?.daysLeft ?? 99; // Unknown expiry: after every dated key.
  return [...keys].sort((x, y) => until(x) - until(y) || daysLeft(x) - daysLeft(y) || x.slot - y.slot);
}

export async function loadOutOfCredit(env: Env): Promise<void> {
  if (!env.USAGE_DB) return;
  try {
    const { results } = await env.USAGE_DB.prepare('SELECT slot, out_of_credit_until FROM key_state')
      .all<{ slot: number; out_of_credit_until: string }>();
    keyState.outOfCredit = new Map(results.map((r) => [r.slot, Date.parse(r.out_of_credit_until)]));
  } catch {
    // Keep the previous view; the in-memory cooldown still sidelines failing keys.
  }
}

/** When the key's credit should be back: its next renewal date, or an hour from now on renewal day itself
 * (credits arrive "shortly after the plan payment is processed"), or 6 hours when no renewal day is set. */
export function creditBackAt(b: Backend, now: number): number {
  if (!b.expiry) return now + 6 * HOUR_MS;
  if (b.expiry.daysLeft === 0) return now + HOUR_MS;
  return Date.parse(`${b.expiry.date}T00:00:00Z`);
}

export async function setOutOfCredit(env: Env, slot: number, until: number | null): Promise<void> {
  if (until === null) keyState.outOfCredit.delete(slot);
  else keyState.outOfCredit.set(slot, until);
  if (!env.USAGE_DB) return;
  try {
    if (until === null) {
      await env.USAGE_DB.prepare('DELETE FROM key_state WHERE slot = ?1').bind(slot).run();
    } else {
      await env.USAGE_DB.prepare(`INSERT INTO key_state (slot, out_of_credit_until, updated_at) VALUES (?1, ?2, ?3)
          ON CONFLICT(slot) DO UPDATE SET out_of_credit_until = ?2, updated_at = ?3`)
        .bind(slot, new Date(until).toISOString(), new Date().toISOString()).run();
    }
  } catch {
    // Best effort; the in-memory state above still applies to this instance.
  }
}

export type HealthState = 'ok' | 'out_of_credit' | 'invalid_key' | 'billing' | 'no_permission' | 'rate_limited'
  | 'upstream_error' | 'unreachable' | 'probe_error';
/** States in which a key cannot serve requests until someone acts or its credit renews. */
export const UNUSABLE: ReadonlySet<HealthState> = new Set(['out_of_credit', 'invalid_key', 'billing', 'no_permission']);

/** What an Anthropic response says about the key that made the request. */
export function classify(status: number, body: string): HealthState {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 400 && OUT_OF_CREDIT.test(body)) return 'out_of_credit';
  if (status === 401) return 'invalid_key';
  if (status === 402) return 'billing';
  if (status === 403) return 'no_permission';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'probe_error';
}

/** Anthropic's error type / message from an error body, if it is one. */
export function errorDetails(text: string): { type: string | null; message: string | null } {
  try {
    const e = (JSON.parse(text) as { error?: { type?: unknown; message?: unknown } }).error;
    return {
      type: typeof e?.type === 'string' ? e.type : null,
      message: typeof e?.message === 'string' ? e.message.slice(0, 300) : null,
    };
  } catch {
    return { type: null, message: null };
  }
}
