# Shows each key slot's priority, credit expiry, whether the key works, and its Console organization ID.
# Checking uses the free model-list endpoint, so it spends no credit.
# Usage (inside this folder):  powershell -ExecutionPolicy Bypass -File .\gateway-status.ps1
param([string]$Base = 'https://claude-multi-key-gateway.yunkangchen2017.workers.dev')
$gatewayKey = (Get-Content -Raw (Join-Path $PSScriptRoot 'gateway-keys\local.txt')).Trim()
$status = Invoke-RestMethod -Uri "$Base/gateway/status" -Headers @{ 'x-api-key' = $gatewayKey }
"Today (UTC): $($status.today_utc)"
"Gateway keys: $($status.gateway_keys -join ', ')  (this PC uses '$($status.your_gateway_key)'; add one with new-gateway-key.ps1)"
$status.keys | Format-Table priority, slot, credit_expires_utc, days_left, key_status, cooling_down, organization_id -AutoSize
