-- One row per /v1/messages call through the gateway. Metadata only: never prompts or replies.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                     -- request start, ISO 8601 UTC
  slot INTEGER,                         -- key slot (1-6) that produced the final response
  organization_id TEXT,
  model TEXT,
  status INTEGER NOT NULL,
  error_type TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 1, -- 0 when the client disconnected mid-stream (counts may be partial)
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  failovers INTEGER NOT NULL DEFAULT 0, -- keys skipped before this one
  duration_ms INTEGER,
  request_id TEXT,
  usage_json TEXT                       -- Anthropic's usage object as returned (cache split, server tools, speed)
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts);
