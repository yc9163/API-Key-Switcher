-- Optional per-project label from the x-gateway-app request header.
ALTER TABLE usage ADD COLUMN app TEXT;

-- Keys that reported "credit balance is too low", shared by every Worker instance.
-- Such a key is tried last until its credit is expected back (its renewal date).
CREATE TABLE IF NOT EXISTS key_state (
  slot INTEGER PRIMARY KEY,
  out_of_credit_until TEXT NOT NULL, -- ISO 8601 UTC
  updated_at TEXT NOT NULL
);
