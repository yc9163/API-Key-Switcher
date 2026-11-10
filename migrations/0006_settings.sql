-- Small values the gateway maintains itself, e.g. "prices": the model price table read daily from Anthropic's
-- pricing page (JSON: table, fetchedAt, checkedAt, error).
CREATE TABLE IF NOT EXISTS settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
