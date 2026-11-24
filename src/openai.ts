/** OpenAI passthrough for one OpenAI key (OPENAI_API_KEY): OpenAI's own request format at /openai/v1/..., with the
 * gateway's keys and spending cap, usage recorded like Claude's (slot OPENAI_SLOT) and the same dashboard and alerts.
 * It is a separate entry point, not a fallback: Claude requests never go to it. Never logs prompts, keys or replies. */
import { keyAlert } from './alerts';
import { estimateOpenAICost } from './openai-pricing';
import {
  classify, creditBackAt, errorDetails, keyLabel, keyState, openaiBackend, openaiOrigin, setOutOfCredit,
  type Backend, type Env,
} from './shared';
import { capMessage, overSpendCap, saveHealth, saveUsage, type HealthResult } from './store';
import { emptyUsage, meteredStream, openaiSse, openaiUsageFromJson, requestModel, withStreamUsage } from './usage';

const MAX_BODY_BYTES = 32_000_000;
// Paths under /openai, their method, and whether they are billed per token (and so recorded and capped).
const ROUTES: Array<{ path: RegExp; method: string; metered: boolean }> = [
  { path: /^\/v1\/chat\/completions$/, method: 'POST', metered: true },
  { path: /^\/v1\/responses$/, method: 'POST', metered: true },
  { path: /^\/v1\/responses\/input_tokens$/, method: 'POST', metered: false },
  { path: /^\/v1\/responses\/[^/]+$/, method: 'GET', metered: false },
  { path: /^\/v1\/embeddings$/, method: 'POST', metered: true },
  { path: /^\/v1\/models(\/[^/]+)?$/, method: 'GET', metered: false },
];
const SUPPORTED = 'POST /openai/v1/chat/completions, POST /openai/v1/responses, POST /openai/v1/responses/input_tokens, GET /openai/v1/responses/{id}, POST /openai/v1/embeddings, GET /openai/v1/models';
const PASS_HEADERS = ['content-type', 'x-request-id', 'retry-after', 'openai-processing-ms',
  'x-ratelimit-limit-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'];

/** An error in OpenAI's format, which OpenAI SDKs parse. */
export function openaiError(status: number, message: string, code = 'gateway_error', extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message, type: code === 'gateway_spending_cap' ? 'rate_limit_error' : 'gateway_error', param: null, code } }),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
}

/** A one-token embedding request (about $0.00000002): tells whether the key works and has credit, since OpenAI
 * answers a key without credit with 429 credit_balance_exhausted on every billed endpoint. */
export async function checkOpenAI(env: Env, b: Backend): Promise<HealthResult> {
  let status = 0;
  let text = '';
  let organizationId: string | null = null;
  try {
    const r = await fetch(`${openaiOrigin(env)}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.OPENAI_CHECK_MODEL || 'text-embedding-3-small', input: 'ok' }),
    });
    status = r.status;
    organizationId = r.headers.get('openai-organization');
    text = await r.text();
  } catch {
    // status stays 0: unreachable
  }
  const state = status === 0 ? 'unreachable' : classify(status, text);
  return { slot: b.slot, state, httpStatus: status || null, message: state === 'ok' ? null : errorDetails(text).message, organizationId };
}

/** Why the GPT key can't be used, for a phone notification. */
export function reasonFor(h: HealthResult, b: Backend): string {
  switch (h.state) {
    case 'out_of_credit': return `额度用完了${b.expiry ? `，${b.expiry.date} 续期后恢复` : ''}`;
    case 'invalid_key': return `API key 无效或已被撤销（HTTP ${h.httpStatus}）`;
    case 'billing': return `达到 OpenAI 的花费或用量上限（HTTP ${h.httpStatus}）`;
    default: return h.message ?? h.state;
  }
}

/** Serves /openai/v1/... for a caller that already passed the gateway-key check. */
export async function handleOpenAI(request: Request, env: Env, ctx: ExecutionContext, url: URL, client: string, now: number): Promise<Response> {
  const path = url.pathname.slice('/openai'.length);
  const route = ROUTES.find((r) => r.path.test(path) && r.method === request.method)
    ?? ROUTES.find((r) => r.path.test(path));
  if (!route) return openaiError(404, `Unsupported path. Supported: ${SUPPORTED}.`, 'not_found');
  if (request.method !== route.method) return openaiError(405, 'Method not allowed.', 'method_not_allowed');
  const b = openaiBackend(env, now);
  if (!b) return openaiError(503, 'No OpenAI key is configured on the gateway (OPENAI_API_KEY).', 'not_configured');
  if (route.metered && await overSpendCap(env, ctx, now)) {
    return openaiError(429, capMessage(env), 'gateway_spending_cap', { 'retry-after': '900' });
  }
  let body: ArrayBuffer | null = null;
  if (request.method === 'POST') {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return openaiError(413, 'Request exceeds gateway 32 MB limit.', 'request_too_large');
    if (path === '/v1/chat/completions') body = withStreamUsage(body);
  }
  const headers = new Headers({ authorization: `Bearer ${b.key}` });
  if (body) headers.set('content-type', request.headers.get('content-type') || 'application/json');
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);
  const fallbackModel = route.metered ? requestModel(body) : null;
  const app = request.headers.get('x-gateway-app')?.trim().slice(0, 64) || null;

  let upstream: Response;
  try {
    upstream = await fetch(openaiOrigin(env) + path + url.search, { method: request.method, headers, body, redirect: 'manual' });
  } catch {
    // The request may have reached OpenAI: don't repeat it (it could be charged twice).
    return openaiError(502, 'Upstream connection failed; request was not automatically retried.', 'upstream_unreachable');
  }
  let errorText: string | null = null;
  if (!upstream.ok) errorText = await upstream.text();
  const organizationId = upstream.headers.get('openai-organization');
  if (errorText !== null) {
    const state = classify(upstream.status, errorText);
    if (state === 'out_of_credit' || state === 'invalid_key' || state === 'billing') {
      const h = { slot: b.slot, state, httpStatus: upstream.status, message: errorDetails(errorText).message, organizationId };
      if (state === 'out_of_credit') ctx.waitUntil(setOutOfCredit(env, b.slot, creditBackAt(b, now)));
      ctx.waitUntil(saveHealth(env, h));
      ctx.waitUntil(keyAlert(env, b.slot, true, reasonFor(h, b)));
    }
  } else if (keyState.outOfCredit.has(b.slot)) {
    ctx.waitUntil(setOutOfCredit(env, b.slot, null));
    ctx.waitUntil(saveHealth(env, { slot: b.slot, state: 'ok', httpStatus: upstream.status, message: null, organizationId }));
    ctx.waitUntil(keyAlert(env, b.slot, false, ''));
  }

  const outHeaders = new Headers();
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) outHeaders.set(name, value);
  }
  outHeaders.set('cache-control', 'no-store');
  outHeaders.set('x-gateway-backend', keyLabel(b.slot).toLowerCase());
  let responseBody: BodyInit | null = errorText ?? upstream.body;
  if (route.metered) {
    const outcome = {
      slot: b.slot, organizationId, status: upstream.status, errorType: errorText === null ? null : errorDetails(errorText).type,
      failovers: 0, requestId: upstream.headers.get('x-request-id'), app, client,
    };
    const isStream = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
    if (errorText === null && isStream && upstream.body) {
      const upstreamBody = upstream.body;
      ctx.waitUntil(new Promise<void>((resolve) => {
        responseBody = meteredStream(upstreamBody, fallbackModel, (usage, completed) =>
          resolve(saveUsage(env, now, { ...outcome, stream: true, completed, usage, cost: estimateOpenAICost(usage) })), openaiSse);
      }));
    } else {
      if (errorText === null) responseBody = await upstream.text();
      const usage = errorText === null ? openaiUsageFromJson(responseBody as string, fallbackModel) : emptyUsage(fallbackModel);
      ctx.waitUntil(saveUsage(env, now, { ...outcome, stream: false, completed: true, usage, cost: estimateOpenAICost(usage) }));
    }
  }
  return new Response(responseBody, { status: upstream.status, headers: outHeaders });
}
