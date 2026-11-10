-- Rate limits and workspace each key's organization reports in its response headers (read on every key check,
-- for HEALTH_CHECK_MODEL): requests, input tokens and output tokens per minute.
ALTER TABLE key_health ADD COLUMN rpm INTEGER;
ALTER TABLE key_health ADD COLUMN itpm INTEGER;
ALTER TABLE key_health ADD COLUMN otpm INTEGER;
ALTER TABLE key_health ADD COLUMN workspace_id TEXT;
