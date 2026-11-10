# Creates a named gateway key that works alongside the others (e.g. one per app, device or person),
# uploads it to Cloudflare as the secret GATEWAY_KEY_<NAME>, and saves it to gateway-keys\<name>.txt.
# Usage requests made with it are recorded under <name>, so the dashboard shows spend per key.
#   Create (or replace):  powershell -ExecutionPolicy Bypass -File .\new-gateway-key.ps1 -Name phone
#   Revoke:               powershell -ExecutionPolicy Bypass -File .\new-gateway-key.ps1 -Name phone -Remove
#   List:                 powershell -ExecutionPolicy Bypass -File .\gateway-status.ps1
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9_]{1,32}$')][string]$Name,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$name = $Name.ToLower()
if ($name -eq 'main') { throw '"main" is the original GATEWAY_KEY; change it with: npx wrangler secret put GATEWAY_KEY' }
$secret = "GATEWAY_KEY_$($Name.ToUpper())"
$dir = Join-Path $PSScriptRoot 'gateway-keys'
$file = Join-Path $dir "$name.txt"
Push-Location $PSScriptRoot # wrangler reads wrangler.jsonc from this folder
try {
  if ($Remove) {
    npx wrangler secret delete $secret
    if ($LASTEXITCODE -ne 0) { throw "wrangler could not delete $secret" }
    Remove-Item $file -ErrorAction SilentlyContinue
    "Revoked gateway key '$name'. Apps still using it now get 401."
    return
  }
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = "gw-$name-" + [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $key | npx wrangler secret put $secret
  if ($LASTEXITCODE -ne 0) { throw "wrangler could not upload $secret" }
  New-Item -ItemType Directory -Force $dir | Out-Null
  [IO.File]::WriteAllText($file, $key, (New-Object System.Text.UTF8Encoding $false))
  ''
  "Gateway key '$name' is live (takes a few seconds). Saved to $file"
  "Key: $key"
} finally {
  Pop-Location
}
