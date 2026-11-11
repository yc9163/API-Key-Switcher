# Claude multi-key Cloudflare Worker

A **native Anthropic Messages API** gateway on Cloudflare Workers that pools up to six Anthropic Console API keys (one per organization, e.g. the monthly API credit of several Claude Max accounts) behind your own gateway keys. It accepts any model ID the keys can use, spends the credit that expires soonest first, fails over when a key is out of credit or failing, records usage, and serves a live dashboard with phone alerts. It does not use LiteLLM.

- Live dashboard: https://claude-multi-key-gateway.yunkangchen2017.workers.dev/
- Picking the project up (current state, runbook, decisions, open items): [HANDOVER.md](HANDOVER.md)
- Developing the code: [DEVELOPMENT.md](DEVELOPMENT.md) · Adding keys (Chinese): [ADD-KEYS.md](ADD-KEYS.md)
- Confirm that routing multiple personal subscriptions together is permitted under your Anthropic terms before using it.

## On a new computer

Everything that runs the gateway (code, settings) is in this repository, and every secret (Anthropic keys, gateway keys, the ntfy topic) is stored in Cloudflare, so nothing has to be copied from the old computer for the gateway to keep working. Editing and deploying needs only the Cloudflare login, none of the secret values; a lost gateway key or ntfy topic is simply replaced with a new one. The full checklist, including the Git identity to commit with, is in [HANDOVER.md](HANDOVER.md) ("On a new computer").

1. Install [Node.js](https://nodejs.org) 22.18 or newer and [Git](https://git-scm.com).
2. Get the code and its tools:
   ```bash
   git clone https://github.com/yc9163/API-Key-Switcher.git
   cd API-Key-Switcher
   npm install
   ```
3. Sign in to the Cloudflare account that owns the Worker (opens a browser): `npx wrangler login`. Check with `npx wrangler secret list`: it should list the `ANTHROPIC_KEY_*` and `GATEWAY_KEY*` names.
4. Edit, test and deploy as described in [DEVELOPMENT.md](DEVELOPMENT.md). `npm run deploy` publishes this computer's copy of the code, so `git pull` first and `git push` after.

Optional, Windows only (the helper scripts are PowerShell): the scripts read `gateway-keys\local.txt`. Give this computer its own gateway key rather than reusing another computer's:
```powershell
powershell -ExecutionPolicy Bypass -File .\new-gateway-key.ps1 -Name laptop   # creates GATEWAY_KEY_LAPTOP, saves gateway-keys\laptop.txt
Copy-Item gateway-keys\laptop.txt gateway-keys\local.txt
powershell -ExecutionPolicy Bypass -File .\install-auto-sync.ps1              # optional: sync usage to usage\ at sign-in
```
The phone keeps receiving alerts regardless of which computer you use; `NTFY_TOPIC.txt` only records the topic name, and is not in Git.

## First-time deploy (Windows PowerShell)

Only needed to create the gateway from scratch in a new Cloudflare account (it already exists). Create the D1 database first (see the end of "Usage tracking"). Open PowerShell inside this folder:

```powershell
npm install
npx wrangler login
npm run migrate
npx wrangler deploy
npx wrangler secret put GATEWAY_KEY
npx wrangler secret put ANTHROPIC_KEY_1   # and so on for each account, up to ANTHROPIC_KEY_6
npx wrangler secret put NTFY_TOPIC        # optional: phone alerts
```

Each secret command asks you to paste its value privately. Create a **new, strong, random** GATEWAY_KEY; do not use your Anthropic API key as the gateway key. You may need to deploy first so Wrangler can associate secrets with the Worker. `secret put` publishes a new version.

After deployment, copy the `https://...workers.dev` URL shown by Wrangler.

## Test

PowerShell (use a gateway key, not an Anthropic key; this spends a fraction of a cent of credit):

```powershell
$base = 'https://claude-multi-key-gateway.yunkangchen2017.workers.dev'
$gatewayKey = Read-Host 'Gateway API key'
$headers = @{
  'x-api-key' = $gatewayKey
  'anthropic-version' = '2023-06-01'
}
$payload = @{
  model = 'claude-opus-5-5'
  max_tokens = 100
  messages = @(@{ role = 'user'; content = 'Hello in Chinese' })
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$base/v1/messages" -Method Post -Headers $headers -ContentType 'application/json' -Body $payload
```

The dashboard lists every model the keys can use; see also the [Claude model documentation](https://platform.claude.com/docs/en/about-claude/models/overview). `anthropic-version` is required by Anthropic (`2023-06-01` is current; the SDKs send it for you). Requests are made with native Anthropic JSON, **not OpenAI Chat Completions**.

Example using `@anthropic-ai/sdk`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({
  apiKey: process.env.GATEWAY_KEY!,
  baseURL: 'https://claude-multi-key-gateway.yunkangchen2017.workers.dev',
});
const reply = await client.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

The gateway also accepts `Authorization: Bearer <GATEWAY_KEY>` for the native endpoint.

## Multiple gateway keys

Besides `GATEWAY_KEY` (recorded as `main`), every secret named `GATEWAY_KEY_<NAME>` is also a valid gateway key, recorded as `<name>` in usage tracking. Give each app, device or person its own, so one can be revoked without touching the others and the dashboard shows spend per key:

```powershell
powershell -ExecutionPolicy Bypass -File .\new-gateway-key.ps1 -Name phone          # create (or replace); saved to gateway-keys\phone.txt
powershell -ExecutionPolicy Bypass -File .\new-gateway-key.ps1 -Name phone -Remove  # revoke
```

The local scripts (`sync-usage.ps1`, `gateway-status.ps1`, `test-gateway.ps1`) use their own key, `local` (`gateway-keys\local.txt`), so rotating `main` never breaks syncing. `gateway-status.ps1` lists the configured key names.

## Replace an account key

All six slots are in use. To replace one (revoked or leaked key, another account), paste the new key with `npx wrangler secret put ANTHROPIC_KEY_N`; no deploy or code change is needed. If the account renews on a different day, also change its `CREDIT_EXPIRY_DAY_N` (below) and deploy. A seventh slot needs a small code change (see HANDOVER.md). The Console steps are in [ADD-KEYS.md](ADD-KEYS.md), part 2.

## Spend soonest-expiring credit first

Monthly Max-plan API credit expires at the end of each billing cycle with no rollover, so the gateway spends the credit that expires soonest first. For each key slot, set the day of the month its credit expires in `wrangler.jsonc` (`CREDIT_EXPIRY_DAY_1` … `_6`, as strings, `"0"` = unknown), then run `npx wrangler deploy`. Find the date in each organization's Console under **Billing → Promotional credits** (shown in UTC).

To see which organization each slot belongs to (compare with **Settings → Organization** in the Console) and the current priority order:

```powershell
powershell -ExecutionPolicy Bypass -File .\gateway-status.ps1
```

`GET /gateway/status` (gateway key required) returns the same data as JSON. It checks each key with the free model-list endpoint, so it spends no credit.

## Online dashboard and key checks

`https://<worker>/` is a public, live usage dashboard (same layout as `usage\report.html`) that works from any device; the API keeps working at the same address under `/v1/...` and still requires a gateway key. Anyone with the address can see key status, spend, renewal dates, gateway-key and app names, models and recent errors (organization IDs are shortened to 8 characters; no keys or prompts are ever shown), and search engines are told not to index it. The older `/dashboard` address and old `?key=` links redirect to `/`.

Public use is kept cheap: `/dashboard/data` is cached for a minute per Worker instance, and "Check keys now" runs at most one real key check per 5 minutes for everyone, however often it is pressed (each check costs about $0.0002 for six keys). To make the dashboard private again, put a `DASHBOARD_KEY` secret: the page then needs a link with `/?key=<DASHBOARD_KEY>` once, after which an HttpOnly cookie signs the browser in (keep that link in `DASHBOARD_LINK.txt` so `sync-usage.ps1` can read the data).

The page refreshes every minute while it is open and shows a red banner (and a "⚠" in the tab title) when a key can't be used: invalid or revoked key, out of credit, billing problem, or no permission. Every key, including standby ones, is checked with a zero-output request (`max_tokens: 0` to `HEALTH_CHECK_MODEL`, a few input tokens each, recorded as app `(key check)`) at most once per `KEY_CHECK_INTERVAL_MINUTES` (wrangler.jsonc, default 60; e.g. `"480"` for about three times a day), triggered by gateway traffic and by opening the dashboard, plus on demand with "Check keys now" (at most once per 5 minutes). A real request that finds a key revoked or out of credit updates the dashboard (and sends a phone alert) immediately, so the interval only affects how soon problems on standby keys show up. There is no cron trigger because this account's 5 free cron slots are used by other Workers; with Workers Paid, add `"triggers": { "crons": ["0 * * * *"] }` to `wrangler.jsonc` to also check while nothing uses the gateway.

Sections: overall key status; this credit cycle (credit left, projected to expire unused, the next renewal with the credit left on those keys and the daily spend that would use it all, spend in the last 24 hours against the cap, and a row per key with status, credit used, renewal, projected unused, today's spend and last check); usage for the last 7, 30 or 90 days grouped by key, model, gateway key or app (spend with change vs the previous period, requests and failures, prompt-caching savings, average cost per request, a daily stacked chart with a table view, an activity heatmap by weekday and local hour, a breakdown table, and cost by token type with the net effect of caching); recent errors. The chosen range and grouping are remembered in the browser, and a view can be bookmarked as `/?days=7&by=model` (`by`: `key`, `model`, `client`, `app`).

## Spending cap and phone alerts

`DAILY_SPEND_CAP_USD` (wrangler.jsonc, default `"100"`, `"0"` = off) caps estimated spend in any rolling 24 hours (the current UTC hour and the 23 before it, from `usage_hourly`). At the cap, `POST /v1/messages` returns `429 rate_limit_error` ("Gateway spending cap reached …", `retry-after: 900`) until older spending leaves the window; free endpoints keep working. It is a runaway guard: each Worker instance re-reads the total at most once a minute and adds its own requests in between, so in-flight requests can overshoot it slightly. Raise it on days you deliberately want to spend more (e.g. using up credit before a renewal), then `npx wrangler deploy`.

Phone notifications go through [ntfy](https://ntfy.sh) when the `NTFY_TOPIC` secret is set (topic saved in `NTFY_TOPIC.txt`; install the ntfy app and subscribe to that topic on server ntfy.sh). They are sent once per change (`alert_state` table): a key becomes unusable (out of credit, invalid or revoked, billing problem, no permission) or works again; spend in the last 24 hours reaches 80% of the cap, reaches the cap, or falls back below it after being capped. Messages contain key numbers and dollar amounts, never keys or prompts. Anyone who knows the topic name can read them, so keep it private; to change it, put a new `NTFY_TOPIC` secret.

The dashboard reads `usage_daily` (totals per UTC day, key slot, gateway key, app and model, updated with each request; the last 180 days), `usage_hourly` (requests and cost per UTC hour, for the heatmap and the cap) and `key_health`; the gateway estimates each request's cost when it records it (`src/pricing.ts`), and the page splits it by token type with each model's base prices. `sync-usage.ps1` saves the same data into `usage\report.html`; opened on a computer that is online, that file switches to live numbers from the gateway (refreshed every minute) and falls back to the saved snapshot when offline.

## What updates itself, and what can't

- **Prices:** once a day the gateway reads Anthropic's pricing page in its markdown form (`https://platform.claude.com/docs/en/about-claude/pricing.md`; free, no API credit), parses the model price table (including tiers such as Claude Haiku 5.5's higher rate above 100,000 prompt tokens), checks the numbers are plausible, and stores them in the `settings` table. If the page can't be read or looks different, the last good table stays in use and the dashboard footer says so; the built-in table in `src/pricing.ts` is the fallback. Fast mode (2x), US-only inference (1.1x) and web search ($10 per 1,000) remain fixed rules.
- **Models:** once a day each key lists its models (Models API, free); the dashboard shows every model with context window, maximum output, price and which keys can use it, and a phone alert announces models that appear later.
- **Rate limits and tier:** every key check reads the `anthropic-ratelimit-*` and `anthropic-workspace-id` response headers (for `HEALTH_CHECK_MODEL`), stored in `key_health`; the dashboard names each organization's tier (Start / Build / Scale and its monthly spend cap) from the documented limits for the 5.5 models.
- **Anthropic's status:** the dashboard reads the public status page (`status.claude.com/api/v2/summary.json`, at most every 5 minutes) and shows the Claude API's state plus any open incidents, so an Anthropic outage can be told apart from a problem with a key.
- **Exact spend:** once a day each key also tries Anthropic's cost report (`/v1/organizations/cost_report`); if it is ever accepted, the dashboard uses Anthropic's figure for that key instead of the estimate. With these keys it returns 401: it needs an Admin API key, which individual accounts can't create.
- **Renewal days and the monthly credit amount:** no Anthropic API exposes credit balances, promotional credits or their expiry (the Admin usage and cost reports need an Admin API key, are unavailable for individual accounts, and report spend only), so these stay in `wrangler.jsonc`. To catch a renewal day that has changed, the recovery notification for a key whose credit comes back on a different UTC day than its configured renewal day says so (or suggests a day if none is set).

## Usage tracking

Every `POST /v1/messages` call is recorded in the `claude-usage` D1 database (binding `USAGE_DB`, schema in `migrations/`): time, key slot, organization, app label, model, status/error type, streaming, token counts (input, output, cache write, cache read), keys skipped, duration, request ID and Anthropic's raw `usage` object. To split usage by project, send an `x-gateway-app: <name>` header (e.g. via the SDK's default headers); it is recorded, never forwarded to Anthropic. Prompts and replies are never stored. Recording happens in the background and never fails or delays a request. Streams pass through unchanged; only the first and last 16 KB are kept in memory to read `message_start` / `message_delta`. If the client disconnects mid-stream, the record has `completed = 0` and the output count may be partial.

To copy the records to this computer and see estimated spend per key in its current credit cycle:

```powershell
powershell -ExecutionPolicy Bypass -File .\sync-usage.ps1
```

It appends new records to `usage\usage.csv` (one row per request; open it in Excel) with the gateway's `est_cost_usd` for each (records from before the gateway priced requests use the table at the top of the script). It then rebuilds `usage\daily.csv`: one row per key per UTC day (days without use included as zeros) with requests, errors, tokens, `est_cost_usd`, and `cycle_to_date_usd`, the running total since that key's last renewal day (`CREDIT_EXPIRY_DAY_N`). The estimates cover only traffic through this gateway; the Console's Billing page has the exact balance. `GET /gateway/usage?after_id=N&limit=1000` (gateway key required) returns the raw rows.

Each sync also saves `usage\report.html`: the online dashboard with a snapshot of its data built in. Opened while the computer is online it shows live numbers; offline, the snapshot.

To sync automatically, register a Windows scheduled task ("Claude gateway usage sync") that runs `auto-sync.ps1` without a window one minute after you sign in and one minute after every unlock (e.g. waking from sleep). The latest run's output is in `usage\last-sync.log`:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-auto-sync.ps1             # install (re-run after moving this folder)
powershell -ExecutionPolicy Bypass -File .\install-auto-sync.ps1 -Uninstall  # remove
```

To recreate the database elsewhere: `npx wrangler d1 create claude-usage`, put its ID in `wrangler.jsonc`, then `npx wrangler d1 migrations apply claude-usage --remote`.

## Routing and caveats

- Keys are tried in order of soonest credit expiry; keys without a configured date come after every dated key, and ties go to the lowest slot. The order is deliberately stable: prompt caches belong to one organization, so keeping traffic on one key keeps cache hits (spreading requests across keys would rebuild the cache in each organization). Gateway tries each configured key in turn when a key can't serve the request: 401 (bad/revoked key), 402 (billing), 403 (no permission), 429 (rate limit / spend cap), 500, 502, 503, 504, 529, and a 400 whose message is about credit balance, spend limits or billing (an organization that ran out of credit). Any other 400 is the request's own fault and is returned immediately.
- A key that reports "credit balance is too low" is recorded in the `key_state` table and tried last by every Worker instance until its renewal date (on renewal day itself, for an hour at a time until the new credit arrives); the record is cleared as soon as the key succeeds again. `GET /gateway/status` shows it as `out_of_credit_until`.
- Keys that just failed with 401/402/other billing errors are tried last for 30 minutes; after a 429, for the `retry-after` time (max 10 minutes). This memory is per Worker instance and best effort.
- `UPSTREAM_ORIGIN` (unset in production) points the gateway at the fake Anthropic API in `dev/` for local testing (see DEVELOPMENT.md).
- Every response carries `x-gateway-backend: N` — the slot (1-6) of the key that served it, never the key itself.
- **No credit balance feed**: Anthropic's API doesn't report remaining credit, so routing uses the configured renewal days and the "credit balance is too low" error, and the dashboard's spend figures are estimates of traffic through the gateway.
- **No guarantee against paid usage**: if an organization has purchased credits, auto-reload, or postpaid billing enabled, requests may spend money after promotional credits run out. Configure each Console account accordingly.
- Native Anthropic endpoints only: `POST /v1/messages` (including streaming as pass-through), `POST /v1/messages/count_tokens`, `GET /v1/models`, `GET /v1/models/{id}`. No OpenAI-compatible `/v1/chat/completions`, files, batches, or other endpoints.
- Streaming response body passes through unchanged once the upstream starts returning successfully; the Worker never retries in the middle of a stream.
- Requests with ambiguous fetch/network errors are not retried to avoid duplicate charges.
- Production: add rate limiting/access policies, logging of metadata without secrets, and stronger abuse protection if this gateway is made accessible outside your own trusted applications. Keep GATEWAY_KEY server-side, never in public frontend JavaScript.
- `/health` endpoint is unauthenticated for availability checks.
