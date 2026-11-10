# Sends a few tiny requests through the gateway and shows which key slot (1-6) served each one.
# Usage (inside this folder):  powershell -ExecutionPolicy Bypass -File .\test-gateway.ps1
param(
  [string]$Base = 'https://claude-multi-key-gateway.yunkangchen2017.workers.dev',
  [string]$Model = 'claude-opus-5-5',
  [int]$Count = 6
)
$gatewayKey = (Get-Content -Raw (Join-Path $PSScriptRoot 'gateway-keys\local.txt')).Trim()
$headers = @{ 'x-api-key' = $gatewayKey; 'anthropic-version' = '2023-06-01' }
$payload = @{
  model = $Model
  max_tokens = 256
  messages = @(@{ role = 'user'; content = 'Reply with just: ok' })
} | ConvertTo-Json -Depth 10

for ($i = 1; $i -le $Count; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "$Base/v1/messages" -Method Post -Headers $headers `
      -ContentType 'application/json' -Body $payload
    $text = ($r.Content | ConvertFrom-Json).content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1
    "#$i  HTTP $($r.StatusCode)  key slot $($r.Headers['x-gateway-backend'])  reply: $($text.text)"
  } catch {
    $resp = $_.Exception.Response
    $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    "#$i  HTTP $([int]$resp.StatusCode)  key slot $($resp.Headers['x-gateway-backend'])  error: $body"
  }
}
