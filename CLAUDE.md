# Claude multi-key gateway

Cloudflare Worker (`claude-multi-key-gateway`) that pools six Anthropic Console API keys (one per Claude Max account,
each with monthly API credit) behind gateway keys, spends the soonest-expiring credit first, fails over between keys,
records usage in D1 and serves a public dashboard at `/`. Live: https://claude-multi-key-gateway.yunkangchen2017.workers.dev

Read [DEVELOPMENT.md](DEVELOPMENT.md) before changing code (layout, local mock, tests, deploy order, gotchas) and
[README.md](README.md) for behaviour and configuration. [ADD-KEYS.md](ADD-KEYS.md) is the owner's guide (in Chinese) to adding keys.

## Commands

- `npm run mock` + `npm run dev` with `.dev.vars` copied from `.dev.vars.example`: local gateway against a fake Anthropic API
- `npm run check`, `npm test`: run both before every deploy
- `npm run migrate` (re-run until ✅) **before** `npm run deploy` when a migration was added

## Rules

- This repository is public: never commit keys, `.dev.vars`, `gateway-keys/`, `NTFY_TOPIC.txt` or `usage/`.
- Deploying publishes to production immediately and secrets are shared by every deploy; settings in `wrangler.jsonc` overwrite dashboard edits.
- Never log or store prompts, replies or keys. Recording and checks are best effort and must never fail or slow a request.
- `wrangler.jsonc` `vars` values are strings.
- The dashboard data is public: keep secrets and full organization IDs out of `dashboardData`.
- Credit balances and renewal dates are not available from any Anthropic API (verified); don't spend effort trying.
