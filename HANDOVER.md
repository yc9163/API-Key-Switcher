# Handover

The one place to pick this project up on another computer, by the owner or by Claude Code: where every piece lives,
what production looks like right now, how to handle the usual situations, what was decided and why, and what is left.
How the code works is in [DEVELOPMENT.md](DEVELOPMENT.md); what the gateway does is in [README.md](README.md).

**Keep this file current.** Claude Code's memory of this project stays on the computer it ran on, so anything worth
knowing next time (a new key, a changed renewal day, a decision, a new idea) belongs here, committed and pushed.

## Where everything lives

| What | Where | If it's lost |
|---|---|---|
| Code, settings (`wrangler.jsonc`), docs | This repository: https://github.com/yc9163/API-Key-Switcher (public) | — |
| The running gateway | Cloudflare Worker `claude-multi-key-gateway` (workers.dev subdomain `yunkangchen2017`); `npx wrangler login` to manage it | Redeploy from this repo |
| Usage history | Cloudflare D1 database `claude-usage`. Nothing is ever deleted from it | — |
| Anthropic keys | Cloudflare secrets `ANTHROPIC_KEY_1` … `_6` | Create a new key in that Console organization and `npx wrangler secret put ANTHROPIC_KEY_N` |
| Gateway keys | Cloudflare secrets `GATEWAY_KEY` (`main`) and `GATEWAY_KEY_<NAME>`; the values also sit wherever each one is used (the apps, `gateway-keys\` on a PC) | Put a new value under the same name; the old value stops working |
| Phone-alert topic | Cloudflare secret `NTFY_TOPIC`, plus `NTFY_TOPIC.txt` on the first PC | Put a new `NTFY_TOPIC` and subscribe the phone to it |
| `usage\` CSVs and `report.html` | On each Windows PC that runs `sync-usage.ps1`; copies of D1 | The first sync on a new PC downloads everything again |
| Automatic usage sync | A scheduled task on each Windows PC (`install-auto-sync.ps1`) | Install it again |

None of these values are needed to edit, test or deploy the gateway: that takes only the Cloudflare login (and GitHub to
push). A lost value is simply replaced, for example with a new gateway key. Cloudflare never shows a secret again, so
keeping the ones in use in a password manager just saves replacing them.

Only the owner's accounts have access. To add a second maintainer, invite them to the Cloudflare account (Manage
Account → Members) and as a collaborator on the GitHub repository.

## Current state (2026-11-11)

- Gateway and public dashboard: https://claude-multi-key-gateway.yunkangchen2017.workers.dev/
- D1 `claude-usage`, id `8ceef542-1ceb-494c-9153-233b464e6a02`, all migrations up to `0007` applied.
- The same Cloudflare account holds the owner's other projects (D1 databases `dayhelper`, `avalon-roundtable`,
  `soniq-agent`, `manyou-data`, and other Workers that use all 5 free cron slots). Don't touch them.

### Anthropic keys

Six Claude Max 20x accounts, each its own Console organization with $200 of API credit per billing cycle, expiring at
the end of the cycle with no rollover. Each organization is Start tier: 4,000 RPM, 2M input and 400K output tokens per
minute on Claude Opus 5.5, and a $500/month Console spend cap. All six could use the same 13 models at the last check,
and all six were working.

| Slot | Credit renews (day of month, UTC) | Organization (first 8 characters) |
|---|---|---|
| 1 | 9 | `acbf2d93` |
| 2 | 9 | `41dba6f8` |
| 3 | 23 | `222b3a46` |
| 4 | 23 | `66fd0cb1` |
| 5 | 27 | `ee483867` |
| 6 | 24 | `01d4ae70` |

Requests go to the key whose credit expires soonest, so the order rotates through the month. On 2026-11-11 it was
3, 4, 6, 5, 1, 2. `gateway-status.ps1` or the dashboard shows the live order.

### Gateway keys

| Name | Secret | Used by |
|---|---|---|
| `main` | `GATEWAY_KEY` | The owner's apps. Rotated by the owner on 2026-10-28 and not stored on any PC |
| `local` | `GATEWAY_KEY_LOCAL` | The PowerShell scripts on the first PC (`gateway-keys\local.txt`) |
| `phone` | `GATEWAY_KEY_PHONE` | The owner's phone (`gateway-keys\phone.txt` on the first PC) |
| `travelscape` | `GATEWAY_KEY_TRAVELSCAPE` | An app of the owner's; the value isn't stored on the first PC |

All 11 secrets: `ANTHROPIC_KEY_1`–`6`, `GATEWAY_KEY`, `GATEWAY_KEY_LOCAL`, `GATEWAY_KEY_PHONE`,
`GATEWAY_KEY_TRAVELSCAPE`, `NTFY_TOPIC`. `DASHBOARD_KEY` is deliberately absent (public dashboard).

### Settings

In `wrangler.jsonc`: renewal days as above, `MONTHLY_CREDIT_USD` 200, key checks every 60 minutes with
`claude-opus-5-5`, spending cap $100 per rolling 24 hours.

## On a new computer

Accounts needed:
- Cloudflare: the account that owns the Worker. Keep two-factor sign-in on; it controls everything.
- GitHub `yc9163`, to push.
- Only for key work: claude.ai and the Console (platform.claude.com) of the account concerned.
- Only for alerts: the ntfy app on the phone.

1. Install Node.js 22.18 or newer and Git.
2. Get the code: `git clone https://github.com/yc9163/API-Key-Switcher.git`, `cd API-Key-Switcher`, `npm install`.
3. Commit as the GitHub noreply address so no personal email lands in the public history:
   `git config user.name yc9163` and `git config user.email 164817117+yc9163@users.noreply.github.com`.
   The first `git push` opens a browser to sign in to GitHub.
4. `npx wrangler login` (browser), then `npx wrangler whoami` and `npx wrangler secret list`: the list should
   match the 11 names above.
5. Check everything works without touching production: `npm run check`, `npm test`, `npx wrangler deploy --dry-run`.
6. To change code, start the local mock as described in [DEVELOPMENT.md](DEVELOPMENT.md); it needs no real keys and
   spends no credit.
7. Optional, Windows only: give the PC its own gateway key and the usage sync (README, "On a new computer"). On macOS or
   Linux, skip the `.ps1` scripts: the dashboard shows everything they do.

Every time: `git pull` before working, `git push` after deploying. `npm run deploy` publishes whatever this computer has.
That holds for one-line settings changes too: a renewal day or the cap edited on a stale copy would deploy old code.

## Common situations

| Situation | What to do |
|---|---|
| A key runs out of credit | Nothing. The gateway moves to the next key, the dashboard marks it (full meter, red), the phone gets an alert, and it returns by itself at renewal. If it happens long before renewal, that organization's credit was also used outside the gateway |
| Phone alert: credit came back on a different day than configured | That key's renewal day changed. `git pull`, edit `CREDIT_EXPIRY_DAY_N` in `wrangler.jsonc`, `npm run deploy`, update the table above, commit, push |
| Requests get `429 Gateway spending cap reached` | The $100 per 24 hours is used up. It clears as older spending leaves the window. To spend more on purpose, e.g. before a renewal, `git pull`, raise `DAILY_SPEND_CAP_USD`, deploy, push, and lower it again afterwards |
| Replace an Anthropic key (revoked, leaked, another account) | `npx wrangler secret put ANTHROPIC_KEY_N`, then "Check keys now" on the dashboard. Console side (turn off auto-reload!): [ADD-KEYS.md](ADD-KEYS.md), part 2 |
| A seventh account | Code change: `SLOTS` and `Env` in `src/shared.ts`, a `CREDIT_EXPIRY_DAY_7` in `wrangler.jsonc`, then test against the mock |
| Give an app, device or person access | Add a gateway key: [ADD-KEYS.md](ADD-KEYS.md), part 1. Revoke it by deleting the secret |
| Rotate `main` | `npx wrangler secret put GATEWAY_KEY`, then update the apps that use it |
| Alerts on a new phone | Install ntfy and subscribe to the topic on server `ntfy.sh`. The topic name is shown in the ntfy app of a phone that's already subscribed (or in `NTFY_TOPIC.txt` on the first PC); if none has it, make a new random one, `npx wrangler secret put NTFY_TOPIC`, and subscribe every phone to it |
| Make the dashboard private | `npx wrangler secret put DASHBOARD_KEY` (README, "Online dashboard") |
| A deploy broke something | `npx wrangler deployments list` shows recent deployments (a `secret put` also creates one); `npx wrangler rollback <version-id>` returns to the one before the bad deploy. Migrations are additive, so older code still works. Then fix, deploy, push |
| `npm run migrate` fails with "A request to the Cloudflare API … failed" | Run it again until the migration shows ✅, before deploying |
| Dashboard footer says prices couldn't be updated | Anthropic changed its pricing page. The last good prices stay in use; fix `parsePricing` in `src/pricing.ts`, with a test |
| See what the Worker is doing | `npx wrangler tail` shows live requests and errors (no request bodies) |

## Decisions and why

- **Native Anthropic API only, no LiteLLM.** A local LiteLLM setup was tried first and dropped: a Worker is always on,
  needs no PC running, and passes any model through unchanged.
- **Spend the soonest-expiring credit first, in a fixed order.** Credit doesn't roll over. Ties go to the lowest slot
  instead of spreading traffic, because prompt caches belong to one organization: spreading requests out would rebuild
  the cache in every organization.
- **Renewal days and the $200 are settings, not looked up.** No Anthropic API exposes credit balances or expiry dates.
  The Admin API needs an Admin key, which individual organizations can't create, and the cost report returned 401 on
  all six keys. Verified on 2026-11-04; don't spend time on it again. The gateway does use every API it can get: prices
  (pricing page), models, rate limits and tier (response headers), and Anthropic's status page.
- **No cron.** The account's 5 free cron slots are used by other Workers, so key checks, price updates and model
  discovery run when gateway traffic or the dashboard triggers them. Workers Paid would allow a cron trigger.
- **Key checks hourly.** The owner said hourly, or even two or three times a day, is enough. A real request that hits a
  broken key reports it immediately anyway. A check costs about $0.0002 for all six keys.
- **Public dashboard (owner's choice).** It's kept cheap to abuse: data cached for a minute, "Check keys now" at most once
  per 5 minutes for everyone, organization IDs shortened, no keys or prompts, not indexed.
- **$100 rolling-24-hour cap (owner's choice).** A runaway guard, not a budget.
- **A key that Anthropic says is out of credit shows a full meter**, with a note that some credit was used outside the
  gateway (owner's request), even when the gateway's own estimate is lower.
- **UTC days everywhere**, matching the Console and when credit expires.
- **Scripts have their own `local` gateway key.** Rotating `main` once silently broke the automatic sync for a week.
- **Only token counts and costs are recorded**, never prompts or replies. Phone alerts are in Chinese.

## Facts about Anthropic worth knowing

- Max-plan API credit can't be used by Claude Code. Don't set `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` globally on a
  machine that runs Claude Code.
- A new Max subscription must be 7 days old before its API credit can be claimed (claude.ai → Settings → Billing → API
  credits, linked to a Console organization).
- If auto-reload or a payment method is enabled in a Console organization, requests can spend real money after the
  credit runs out, and the gateway won't move to another key. Keep both off.
- `max_tokens: 0` requests are accepted and cost only the input tokens, so the gateway uses them as key checks.

## Open items and ideas

- An early Console screenshot showed one organization's credit expiring on the 11th, which matches no configured day.
  Worth a look at each organization's Billing → Promotional credits page. If a key's credit comes back on another day,
  its recovery alert says so.
- Some of the owner's traffic has no `x-gateway-app` header: a Haiku app that pre-warms a 10–24K-token prompt cache every
  few minutes. Tagging it would split it out on the dashboard. Its refresh interval should stay under 5 minutes, or each
  warm-up writes the cache again.
- Offered but not built:
  - a phone reminder a few days before a key renews with much credit left, so it gets used;
  - Message Batches passthrough (50% cheaper, but a batch must stay on the key that created it);
  - local-time days in `daily.csv`;
  - a cron trigger, if the account moves to Workers Paid.

## History

- **2026-10-28:** gateway deployed with keys 1–3; soonest-expiry routing; usage recorded in D1; the CSV sync and its
  scheduled task.
- **2026-11-04:**
  - named gateway keys, and keys 4–6;
  - the online dashboard, made public and moved to `/`;
  - the spending cap, phone alerts and the heatmap;
  - hourly key checks;
  - automatic prices and model discovery, the status page, rate limits and tier.
- **2026-11-11:** code published to GitHub, with the local mock, tests, DEVELOPMENT.md and this handover.
