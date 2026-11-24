# Developing the gateway

How the code is organised, how to run it locally without real keys, and how to ship a change safely.
For what the gateway does and how to use it, see [README.md](README.md).

## How a request flows

1. `src/index.ts` authenticates the caller against `GATEWAY_KEY` / `GATEWAY_KEY_<NAME>` secrets (the matching name is recorded as `client`).
2. `/v1/messages` checks the rolling 24-hour spending cap, then tries the Anthropic keys in `keyOrder` (`src/shared.ts`): soonest credit expiry first, keys cooling down or out of credit last, ties to the lowest slot (stable on purpose, so prompt caches stay in one organization).
3. Account-level failures (401/402/403/429/5xx/529, or a 400 about credit/billing) move on to the next key; an out-of-credit key is remembered in D1 (`key_state`) until its renewal date; the dashboard's `key_health` and phone alerts are updated.
4. The response is passed through. Streams go through `meteredStream` (`src/usage.ts`), which keeps only the first and last 16 KB to read the token counts; non-streaming bodies are parsed whole.
5. In the background (`ctx.waitUntil`) the request is recorded (`src/store.ts`: `usage`, `usage_daily`, `usage_hourly`), and periodic jobs run when due: key checks, the price refreshes, model discovery.
6. `/openai/v1/...` goes to `src/openai.ts` instead: same gateway keys and spending cap, then the one OpenAI key (no failover; it is never a fallback for Claude). It is recorded with slot `100` (`OPENAI_SLOT`), priced with `src/openai-pricing.ts`, and shown on the dashboard as "GPT".

Nothing that records or checks is allowed to fail or slow down a request: every D1 write and outside call is best effort and wrapped in `try`.

## Code layout

| Path | What it is |
|---|---|
| `src/index.ts` | Routing, gateway-key auth, failover across keys, spending cap, recording each request |
| `src/shared.ts` | `Env` (all config), key order, renewal-date maths, shared out-of-credit state, error classification |
| `src/usage.ts` | Reads token usage from JSON and SSE responses, Anthropic's and OpenAI's (`SseUsageScanner`, `meteredStream`, `openaiSse`) |
| `src/pricing.ts` | Price table (refreshed daily from Anthropic's pricing page, built-in fallback) and cost estimate |
| `src/store.ts` | D1 reads/writes: usage rows, daily and hourly totals, key health, `/gateway/usage`; the shared spending cap |
| `src/openai.ts` | The GPT entry point (`/openai/v1/...`): routes, passthrough, recording, the GPT key check |
| `src/openai-pricing.ts` | OpenAI price table (refreshed daily from OpenAI's pricing page, built-in fallback) and cost estimate |
| `src/dashboard.ts` | Key checks (`max_tokens: 0` probes; a one-token embedding for GPT), dashboard routes (`/`, `/dashboard/data`, `/dashboard/check`) and the data the page renders |
| `src/discover.ts` | Daily model list and cost-report probe per key; Anthropic status page |
| `src/alerts.ts` | Phone notifications through ntfy, sent once per change (`alert_state`) |
| `report-template.html` | The whole dashboard UI (vanilla JS + inline SVG). The Worker serves it live; `sync-usage.ps1` embeds a data snapshot into a copy |
| `migrations/` | D1 schema, applied in filename order |
| `wrangler.jsonc` | Worker name, D1 binding and plain settings (`vars`) |
| `dev/mock-anthropic.mjs` | Fake Anthropic API, OpenAI API (under `/openai`) and ntfy for local development |
| `test/` | Offline unit tests (`npm test`) |
| `*.ps1` | Windows helper scripts: usage sync, key management, status, scheduled task |

### D1 tables (`claude-usage`)

| Table | Contents |
|---|---|
| `usage` | One row per metered call (`/v1/messages`, and GPT generations and embeddings with slot `100`): time, key slot, gateway key (`client`), app, model, status, tokens, estimated cost, raw `usage` JSON. Never prompts or replies |
| `usage_daily` | Running totals per UTC day / slot / client / app / model. The dashboard reads only this (cheap) |
| `usage_hourly` | Requests and cost per UTC hour: the activity heatmap and the spending cap |
| `key_state` | Keys that reported running out of credit (Anthropic's "credit balance is too low", OpenAI's `credit_balance_exhausted`), until when |
| `key_health` | Latest check result per slot, with rate limits and workspace from the response headers |
| `alert_state` | Last state notified per subject (`key:<slot>`, `cap`) |
| `settings` | JSON blobs the gateway maintains: `prices`, `openai_prices`, `discovery` |

### Configuration

- **Secrets** (in Cloudflare only; `npx wrangler secret list` shows the names): `GATEWAY_KEY`, `GATEWAY_KEY_<NAME>`, `ANTHROPIC_KEY_1` … `_6`, `OPENAI_API_KEY` (the GPT key, optional), `NTFY_TOPIC`, optionally `DASHBOARD_KEY` (makes the dashboard private).
- **Settings** (`vars` in `wrangler.jsonc`, deployed with the code): renewal days, monthly credit, key-check model and interval, spending cap, public URL. Keep every value a **string**; numbers there stop `.dev.vars` from loading under `wrangler dev`.
- A setting changed in the Cloudflare dashboard is overwritten by the next `npm run deploy`; change it in `wrangler.jsonc` instead. Secrets are never touched by a deploy.

## Local development

Needs Node.js 22.18 or newer (the tests run TypeScript directly). The commands below are for a bash shell: on Windows,
use Git Bash (installed with Git). The `npm` commands also work in PowerShell; there, use `curl.exe` instead of `curl`
(in Windows PowerShell `curl` is a different command) and `Remove-Item -Recurse -Force` instead of `rm -rf`.

```bash
npm install
cp .dev.vars.example .dev.vars   # fake keys, pointed at the mock; git-ignored
npm run migrate:local            # creates the local D1 database (once, and after adding a migration)
npm run mock                     # terminal 1: fake Anthropic API on 127.0.0.1:8798
npm run dev                      # terminal 2: the gateway on http://127.0.0.1:8799
```

Then open http://127.0.0.1:8799/ for the dashboard, or send requests:

```bash
curl -X POST http://127.0.0.1:8799/v1/messages -H "x-api-key: local-dev-gateway-key" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-opus-5-5","max_tokens":20,"messages":[{"role":"user","content":"hi"}]}'
```

The mock's keys behave differently (`sk-good-*` work, `sk-broke` is out of credit, `sk-revoked` is invalid); change its behaviour while it runs, and see what reached it:

```bash
curl -X POST http://127.0.0.1:8798/__toggle -d '{"broke":false}'       # out-of-credit key gets credit back
curl -X POST http://127.0.0.1:8798/__toggle -d '{"overloaded":true}'   # working keys answer 529
curl -X POST http://127.0.0.1:8798/__toggle -d '{"extraModel":true}'   # a new model appears
curl -X POST http://127.0.0.1:8798/__toggle -d '{"gptBroke":true}'     # the GPT key runs out of credit
curl http://127.0.0.1:8798/__hits                                       # requests the gateway sent
curl http://127.0.0.1:8798/__ntfy                                       # phone notifications it sent
```

`POST /cdn-cgi/local/scheduled` is not needed: there is no cron trigger; key checks run on traffic and dashboard loads (`KEY_CHECK_INTERVAL_MINUTES`). Reset local data with `rm -rf .wrangler/state` and `npm run migrate:local`.

GPT requests go to `http://127.0.0.1:8799/openai/v1/...` with `authorization: Bearer local-dev-gateway-key`; the mock's Responses stream ends with a `response.completed` line longer than the 16 KB the gateway keeps, like long real replies.

If port 8798 is taken by another program, start the mock with `MOCK_PORT=8797 npm run mock` and change the three `8798` addresses in `.dev.vars` to match.

On Windows, `wrangler dev` processes started in the background survive the terminal and keep reloading when files change. Stop them when done, e.g. in PowerShell:
`Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'node.exe','workerd.exe' -and $_.CommandLine -match 'wrangler|mock-anthropic' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`

## Checks

```bash
npm run check   # TypeScript
npm test        # offline unit tests: usage parsing/streaming, both pricing pages and cost, OpenAI errors
```

Add a test in `test/` for any parsing or calculation logic you change. The dashboard has no automated test: check it in a browser against the mock (light and dark mode, and a narrow window for phones).

## Shipping a change

1. `npm run check && npm test`
2. If you added a migration: `npm run migrate` **before** deploying, and make sure the output shows the migration with ✅. Cloudflare's API sometimes fails a migration with "A request to the Cloudflare API … failed": just run it again. Deploying code that writes to a table or column that doesn't exist yet makes those writes fail silently (requests still work, but recording stops).
3. `npm run deploy`
4. Verify on the live dashboard (`/`), or `curl https://<worker>/dashboard/data`.
5. Commit and `git push`. If keys, renewal days, settings or decisions changed, update [HANDOVER.md](HANDOVER.md) in the same commit.

Migrations: add a new numbered file (`0008_...sql`); never edit one that has been applied. Keep them additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN`).

Deploys go straight to production: `npm run deploy` from any computer publishes that computer's code, so `git pull` first.

## Things to keep in mind

- The dashboard and `/dashboard/data` are **public** unless `DASHBOARD_KEY` is set. Never add keys, prompts, full organization IDs or anything secret to `dashboardData`.
- Public endpoints must stay cheap to abuse: `/dashboard/data` is cached per instance for a minute, and "Check keys now" is limited to one real check per 5 minutes for everyone.
- The free Workers plan allows 10 ms CPU per request: keep per-chunk work in `meteredStream` minimal and avoid parsing large bodies.
- The account's free cron slots are used by other Workers, so periodic work is triggered by traffic (`maybeCheckKeys`, `maybeUpdatePrices`, `maybeDiscover`).
- Nothing in Anthropic's API exposes credit balances or renewal dates; those stay in `wrangler.jsonc` (see README, "What updates itself").
- Remote D1 limits on the free plan: 5 million rows read and 100,000 rows written per day. Each request writes about five rows.
- In `report-template.html`, the header uses the CSS class `top`; don't reuse it inside other components.
- `npm test` runs the TypeScript with Node directly, which can't follow extensionless imports such as `./store`. Keep parsing and calculation code in modules with no runtime imports (`usage.ts`, `pricing.ts`, `openai-pricing.ts`, `shared.ts`) so tests can load it.
- The GPT key uses slot `100` in every table; Claude slots stay 1-6 (more would be 7, 8, ...). The dashboard names and colours keys by slot (`keyName`, `keyColor` in the page; `keyLabel` in `src/shared.ts`).
