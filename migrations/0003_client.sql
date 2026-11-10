-- Which gateway key the caller used: "main" for GATEWAY_KEY, or <name> for a GATEWAY_KEY_<NAME> secret.
ALTER TABLE usage ADD COLUMN client TEXT;
