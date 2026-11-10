-- Estimated USD cost of each request, computed by the gateway when it is recorded.
ALTER TABLE usage ADD COLUMN est_cost_usd REAL;

-- Lets the dashboard list recent failures without scanning every request.
CREATE INDEX IF NOT EXISTS usage_errors ON usage (id) WHERE status != 200;

-- Running totals per UTC day, key slot, gateway key, app and model; the dashboard reads only this.
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  slot INTEGER NOT NULL,
  client TEXT NOT NULL DEFAULT '', -- gateway key name; '' for the gateway's own key checks
  app TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, slot, client, app, model)
);

-- Latest result of the scheduled key check (or of a real request that found the key broken).
CREATE TABLE IF NOT EXISTS key_health (
  slot INTEGER PRIMARY KEY,
  state TEXT NOT NULL, -- ok, out_of_credit, invalid_key, billing, no_permission, rate_limited, upstream_error, unreachable, probe_error
  http_status INTEGER,
  message TEXT,
  organization_id TEXT,
  checked_at TEXT NOT NULL -- ISO 8601 UTC
);
