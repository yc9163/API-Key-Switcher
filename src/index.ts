/** Minimal Anthropic API gateway that pools several Anthropic Console API keys.
 * Native Anthropic protocol only (including SSE streaming): POST /v1/messages,
 * POST /v1/messages/count_tokens, GET /v1/models and GET /v1/models/{id}.
 * GET /gateway/status reports each key slot's priority, credit expiry, health and organization;
 * GET /gateway/usage pages through the per-request token usage recorded in D1; callers may label requests
 * with an `x-gateway-app: <project>` header for per-project breakdowns. /dashboard serves a live usage
 * dashboard; every key is re-checked at most every 15 minutes, driven by traffic and dashboard loads.
 * Never logs prompts, API keys, or response bodies.
 */
import { capAlert, keyAlert } from './alerts';
import { checkKeys, creditReturnHint, cycleStartFor, describeHealth, handleDashboard, maybeCheckKeys } from './dashboard';
import { maybeDiscover } from './discover';
import { maybeUpdatePrices } from './pricing';
import {
  backends, classify, cooldownUntil, creditBackAt, error, errorDetails, gatewayKeys, json, keyOrder, keyState,
  loadOutOfCredit, OUT_OF_CREDIT, sameSecret, setOutOfCredit, spendCap, spendState, upstreamOrigin,
  type Backend, type Env,
} from './shared';
import { loadSpend, readHealth, saveHealth, saveUsage, usageRows } from './store';
import { emptyUsage, meteredStream, requestModel, usageFromJson } from './usage';

const MAX_BODY_BYTES = 32_000_000; // Anthropic's own Messages API request limit.
// Statuses where a different key (a different organization) may succeed.
const FAILOVER = new Set([401, 402, 403, 429, 500, 502, 503, 504, 529]);
// A 400 is normally the caller's fault; these messages mean the organization is out of credit or over a spend limit.
const ACCOUNT_400 = /credit balance|spend limit|billing|purchase credits/i;
const AUTH_OR_BILLING_COOLDOWN_MS = 30 * 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;
const KEY_STATE_REFRESH_MS = 60_000;
const SPEND_REFRESH_MS = 60_000;
const PASS_HEADERS = ['content-type', 'request-id', 'retry-after', 'anthropic-organization-id',
  'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-tokens-reset'];

function allowedMethod(pathname: string): string | null {
  if (pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens') return 'POST';
  if (pathname === '/v1/models' || /^\/v1\/models\/[^/]+$/.test(pathname)) return 'GET';
  return null;
}

function cooldownFor(status: number, retryAfter: string | null): number {
  if (status === 401 || status === 402 || status === 400) return AUTH_OR_BILLING_COOLDOWN_MS;
  if (status === 429) {
    const seconds = Number(retryAfter);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RATE_LIMIT_COOLDOWN_MS) : 60_000;
  }
  return 0; // 403 can be model-specific and 5xx/529 are transient: fail over, but don't sideline the key.
}

/** Priority order plus a free GET /v1/models per key to confirm it works and learn its organization. */
async function status(env: Env, keys: Backend[], now: number, extra: Record<string, unknown>): Promise<Response> {
  const order = keyOrder(keys, now).map((b) => b.slot);
  const health = await readHealth(env);
  const rows = await Promise.all(keys.map(async (b) => {
    let keyStatus: number | string;
    let organizationId: string | null = null;
    try {
      const r = await fetch(`${upstreamOrigin(env)}/v1/models?limit=1`, {
        headers: { 'x-api-key': b.key, 'anthropic-version': '2023-06-01' },
      });
      await r.body?.cancel();
      keyStatus = r.status;
      organizationId = r.headers.get('anthropic-organization-id');
    } catch {
      keyStatus = 'unreachable';
    }
    const creditBack = keyState.outOfCredit.get(b.slot) ?? 0;
    const h = health.get(b.slot);
    return {
      slot: b.slot, priority: order.indexOf(b.slot) + 1, credit_expiry_day: b.expiry?.day ?? null, credit_expires_utc: b.expiry?.date ?? 'unknown',
      days_left: b.expiry?.daysLeft ?? null, cooling_down: (cooldownUntil.get(b.slot) ?? 0) > now,
      out_of_credit_until: creditBack > now ? new Date(creditBack).toISOString() : null,
      key_status: keyStatus, organization_id: organizationId,
      health: h ? { state: h.state, http_status: h.http_status, message: h.message, checked_at: h.checked_at } : null,
    };
  }));
  return json({ today_utc: new Date(now).toISOString().slice(0, 10), ...extra, keys: rows.sort((a, b) => a.priority - b.priority) });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ status: 'ok' });
    if (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      return handleDashboard(request, env, url);
    }
    const isStatus = url.pathname === '/gateway/status';
    const isUsage = url.pathname === '/gateway/usage';
    const method = isStatus || isUsage ? 'GET' : allowedMethod(url.pathname);
    if (!method) return error(404, 'Unsupported path. Supported: POST /v1/messages, POST /v1/messages/count_tokens, GET /v1/models, GET /gateway/status, GET /gateway/usage.');
    if (request.method !== method) return error(405, 'Method not allowed.');
    const allowed = gatewayKeys(env);
    if (allowed.length === 0) return error(503, 'Gateway is not configured.');
    // SDKs typically send x-api-key; also accept standard Bearer for convenience.
    const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    const provided = (request.headers.get('x-api-key') ?? bearer).trim();
    let client: string | null = null;
    for (const g of allowed) if (sameSecret(provided, g.key)) client = g.name; // Check all; no early exit.
    if (!provided || client === null) return error(401, 'Invalid gateway key.');
    if (isUsage) return usageRows(env, url);
    const now = Date.now();
    const keys = backends(env, now);
    if (keys.length === 0) return error(503, 'No Anthropic backends configured.');
    if (isStatus) {
      await loadOutOfCredit(env);
      keyState.loadedAt = now;
      return status(env, keys, now, { gateway_keys: allowed.map((g) => g.name), your_gateway_key: client });
    }
    if (now - keyState.loadedAt > KEY_STATE_REFRESH_MS) {
      keyState.loadedAt = now;
      ctx.waitUntil(loadOutOfCredit(env)); // This request uses the current view; later ones see the refresh.
    }
    ctx.waitUntil(maybeCheckKeys(env, now)); // Background key check, at most once per KEY_CHECK_INTERVAL_MINUTES.
    ctx.waitUntil(maybeUpdatePrices(env, now)); // Keeps the price table current (pricing page read at most daily).
    ctx.waitUntil(maybeDiscover(env, now, cycleStartFor(now))); // Models per key, cost-report access (daily).
    const metered = url.pathname === '/v1/messages'; // count_tokens and models are free.
    const cap = spendCap(env);
    if (metered && cap) {
      // Spending cap over the rolling 24 hours. A new instance loads the figure before its first request; after
      // that it is refreshed in the background at most once a minute. A runaway guard: in-flight requests and
      // other instances can overshoot it a little.
      if (spendState.loadedAt === 0) {
        spendState.loadedAt = now;
        ctx.waitUntil(capAlert(env, await loadSpend(env, now)));
      } else if (now - spendState.loadedAt > SPEND_REFRESH_MS) {
        spendState.loadedAt = now;
        ctx.waitUntil(loadSpend(env, now).then((spent) => capAlert(env, spent)));
      }
      if (spendState.spent >= cap) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error',
          message: `Gateway spending cap reached: about $${spendState.spent.toFixed(2)} spent in the last 24 hours (cap $${cap.toFixed(2)}). Requests resume as older spending leaves the 24-hour window.` } }),
          { status: 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '900' } });
      }
    }
    const incomingVersion = request.headers.get('anthropic-version');
    if (!incomingVersion) return error(400, 'anthropic-version header is required.');
    // Same request body is replayed only on errors before a successful response is returned;
    // never after a successful streaming response begins.
    let body: ArrayBuffer | null = null;
    if (method === 'POST') {
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return error(413, 'Request exceeds gateway 32 MB limit.');
    }
    const target = upstreamOrigin(env) + url.pathname + url.search;
    const fallbackModel = metered ? requestModel(body) : null;
    // Optional label so usage can be broken down per project; never sent on to Anthropic.
    const app = request.headers.get('x-gateway-app')?.trim().slice(0, 64) || null;
    const order = keyOrder(keys, now);
    for (let i = 0; i < order.length; i++) {
      const { key, slot } = order[i];
      const isLast = i + 1 === order.length;
      const headers = new Headers({ 'x-api-key': key, 'anthropic-version': incomingVersion });
      if (body) headers.set('content-type', 'application/json');
      // Preserve Anthropic beta feature and workspace routing headers if supplied.
      for (const name of ['anthropic-beta', 'anthropic-workspace-id']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      let upstream: Response;
      try {
        upstream = await fetch(target, { method, headers, body: body?.slice(0), redirect: 'manual' });
      } catch {
        // Network failure may occur after Anthropic receives the request: retry can double-charge.
        // Fail closed rather than repeat an ambiguous request.
        return error(502, 'Upstream connection failed; request was not automatically retried.');
      }
      // Error bodies are small JSON; read them to tell "out of credit" apart from a malformed request.
      let errorText: string | null = null;
      if (!upstream.ok) errorText = await upstream.text();
      const accountProblem = FAILOVER.has(upstream.status)
        || (upstream.status === 400 && ACCOUNT_400.test(errorText ?? ''));
      if (accountProblem) {
        const cooldown = cooldownFor(upstream.status, upstream.headers.get('retry-after'));
        if (cooldown > 0) cooldownUntil.set(slot, Date.now() + cooldown);
        // Out of credit lasts until renewal: tell every instance, not just this one.
        if (OUT_OF_CREDIT.test(errorText ?? '')) ctx.waitUntil(setOutOfCredit(env, slot, creditBackAt(order[i], now)));
        // A key that is out of credit, revoked or has a billing problem shows on the dashboard right away
        // (403 is left to the scheduled check: it can be specific to the requested model).
        const state = classify(upstream.status, errorText ?? '');
        if (state === 'out_of_credit' || state === 'invalid_key' || state === 'billing') {
          const h = { slot, state, httpStatus: upstream.status, message: errorDetails(errorText ?? '').message,
            organizationId: upstream.headers.get('anthropic-organization-id') };
          ctx.waitUntil(saveHealth(env, h));
          ctx.waitUntil(keyAlert(env, slot, true, describeHealth(h, order[i])));
        }
        if (!isLast) continue;
      } else if (upstream.ok) {
        cooldownUntil.delete(slot);
        if (keyState.outOfCredit.has(slot)) {
          // Credit is back: clear the mark and the dashboard's "out of credit" check result together.
          ctx.waitUntil(setOutOfCredit(env, slot, null));
          ctx.waitUntil(saveHealth(env, { slot, state: 'ok', httpStatus: upstream.status, message: null,
            organizationId: upstream.headers.get('anthropic-organization-id') }));
          ctx.waitUntil(keyAlert(env, slot, false, creditReturnHint(order[i], now)));
        }
      }
      const outHeaders = new Headers();
      for (const name of PASS_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) outHeaders.set(name, value);
      }
      outHeaders.set('cache-control', 'no-store');
      // Which configured slot (1-6) served the request; never the key itself.
      outHeaders.set('x-gateway-backend', String(slot));
      let responseBody: BodyInit | null = errorText ?? upstream.body;
      if (metered) {
        const outcome = {
          slot, organizationId: upstream.headers.get('anthropic-organization-id'), status: upstream.status,
          errorType: errorText === null ? null : errorDetails(errorText).type, failovers: i,
          requestId: upstream.headers.get('request-id'), app, client,
        };
        const isStream = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
        if (errorText === null && isStream && upstream.body) {
          const upstreamBody = upstream.body;
          ctx.waitUntil(new Promise<void>((resolve) => {
            responseBody = meteredStream(upstreamBody, fallbackModel, (usage, completed) =>
              resolve(saveUsage(env, now, { ...outcome, stream: true, completed, usage })));
          }));
        } else {
          // Non-streaming replies are read whole anyway by the client, so buffering adds no delay.
          if (errorText === null) responseBody = await upstream.text();
          const usage = errorText === null ? usageFromJson(responseBody as string, fallbackModel) : emptyUsage(fallbackModel);
          ctx.waitUntil(saveUsage(env, now, { ...outcome, stream: false, completed: true, usage }));
        }
      }
      return new Response(responseBody, { status: upstream.status, headers: outHeaders });
    }
    return error(502, 'No Anthropic backend available.');
  },

  /** For a cron trigger, if one is added to wrangler.jsonc (the account's free cron slots are in use today). */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkKeys(env, Date.now()));
  },
};
