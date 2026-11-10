-- Requests and estimated cost per UTC hour (API requests through the gateway, not its own key checks).
-- The dashboard's activity heatmap and the rolling 24-hour spending cap read this.
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour TEXT PRIMARY KEY, -- 'YYYY-MM-DDTHH', UTC
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0
);
INSERT OR REPLACE INTO usage_hourly (hour, requests, errors, est_cost_usd)
  SELECT substr(ts, 1, 13), COUNT(*), SUM(status != 200), SUM(COALESCE(est_cost_usd, 0)) FROM usage GROUP BY 1;

-- Last state a phone notification was sent for, per subject ("key:<slot>" = ok | down, "cap" = ok | warn | hit),
-- so each change is notified once even when several Worker instances notice it.
CREATE TABLE IF NOT EXISTS alert_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
