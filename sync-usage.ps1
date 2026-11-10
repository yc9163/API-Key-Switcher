# Downloads new usage records from the gateway into usage\usage.csv (one row per request), rebuilds
# usage\daily.csv (estimated credit used per key per UTC day; both open in Excel), and saves an offline
# snapshot of the online dashboard to usage\report.html (open it in a browser).
# Records stay in the gateway's database too, so running this occasionally loses nothing.
# Usage (inside this folder):  powershell -ExecutionPolicy Bypass -File .\sync-usage.ps1
param([string]$Base = 'https://claude-multi-key-gateway.yunkangchen2017.workers.dev')
$ErrorActionPreference = 'Stop'
$headers = @{ 'x-api-key' = (Get-Content -Raw (Join-Path $PSScriptRoot 'gateway-keys\local.txt')).Trim() }
$dir = Join-Path $PSScriptRoot 'usage'
New-Item -ItemType Directory -Force $dir | Out-Null
$csv = Join-Path $dir 'usage.csv'

# USD per million tokens: input, 5-minute cache write, 1-hour cache write, cache read, output.
# From platform.claude.com/docs/en/about-claude/pricing on 2026-10-28 - edit here if prices change.
# Longest matching model-ID prefix wins.
$prices = @{
  'claude-fable-5-1'  = 10, 12.5, 20, 0.25, 50
  'claude-mythos-5-1' = 10, 12.5, 20, 0.25, 50
  'claude-fable-5'    = 10, 12.5, 20, 1, 50
  'claude-opus-5-5'   = 4, 5, 8, 0.20, 20
  'claude-opus-5'     = 5, 6.25, 10, 0.50, 25
  'claude-opus-4-8'   = 5, 6.25, 10, 0.50, 25
  'claude-opus-4-7'   = 5, 6.25, 10, 0.50, 25
  'claude-opus-4-6'   = 5, 6.25, 10, 0.50, 25
  'claude-sonnet-5-5' = 2, 2.5, 4, 0.10, 10
  'claude-sonnet-5'   = 2, 2.5, 4, 0.20, 10
  'claude-sonnet-4-6' = 3, 3.75, 6, 0.30, 15
  'claude-haiku-5-5'  = 0.10, 0.125, 0.20, 0.01, 0.50
  'claude-haiku-4-5'  = 1, 1.25, 2, 0.10, 5
}
$haiku55Long = 0.50, 0.625, 1, 0.05, 2.50 # Claude Haiku 5.5 prompts over 100,000 tokens.
$prefixes = $prices.Keys | Sort-Object Length -Descending

function Get-EstimatedCost($row) {
  if (-not $row.model) { return $null }
  $match = $prefixes | Where-Object { $row.model.StartsWith($_) } | Select-Object -First 1
  if (-not $match) { return $null }
  $p = $prices[$match]
  $u = $null
  if ($row.usage_json) { $u = $row.usage_json | ConvertFrom-Json }
  $write5m = [double]$row.cache_creation_input_tokens
  $write1h = 0.0
  if ($u -and $u.cache_creation) {
    $write5m = [double]$u.cache_creation.ephemeral_5m_input_tokens
    $write1h = [double]$u.cache_creation.ephemeral_1h_input_tokens
  }
  $prompt = [double]$row.input_tokens + [double]$row.cache_creation_input_tokens + [double]$row.cache_read_input_tokens
  if ($match -eq 'claude-haiku-5-5' -and $prompt -gt 100000) { $p = $haiku55Long }
  $cost = ([double]$row.input_tokens * $p[0] + $write5m * $p[1] + $write1h * $p[2] +
    [double]$row.cache_read_input_tokens * $p[3] + [double]$row.output_tokens * $p[4]) / 1e6
  if ($u -and $u.speed -eq 'fast') { $cost *= 2 }        # Fast mode: 2x on these models.
  if ($u -and $u.inference_geo -eq 'us') { $cost *= 1.1 } # US-only inference.
  if ($u -and $u.server_tool_use -and $u.server_tool_use.web_search_requests) {
    $cost += [double]$u.server_tool_use.web_search_requests * 0.01 # $10 per 1,000 searches.
  }
  return [math]::Round($cost, 6)
}

# --- Download records newer than the last one already saved.
$existing = @()
if (Test-Path $csv) { $existing = @(Import-Csv $csv) }
$columns = 'id', 'time_utc', 'time_local', 'slot', 'client', 'app', 'model', 'status', 'error_type', 'stream', 'completed',
  'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'est_cost_usd',
  'failovers', 'duration_ms', 'organization_id', 'request_id', 'usage_json'
# Columns added since the file was created: client (gateway key used; every earlier request used "main") and app.
$addDefaults = [ordered]@{ client = 'main'; app = '' }
$missing = @()
if ($existing.Count -gt 0) { $missing = @($addDefaults.Keys | Where-Object { $existing[0].PSObject.Properties.Name -notcontains $_ }) }
if ($missing.Count -gt 0) {
  $existing = @($existing | ForEach-Object {
    foreach ($m in $missing) { $_ | Add-Member -NotePropertyName $m -NotePropertyValue $addDefaults[$m] }
    $_
  } | Select-Object $columns)
  try {
    $existing | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8
  } catch {
    "Could not update $csv (is it open in Excel?). Close it and run again - nothing is lost."
    return
  }
}
$lastId = 0
if ($existing.Count -gt 0) { $lastId = [int]$existing[-1].id }
$new = New-Object System.Collections.Generic.List[object]
do {
  $page = Invoke-RestMethod -Uri "$Base/gateway/usage?after_id=$lastId&limit=1000" -Headers $headers
  foreach ($r in $page.rows) {
    $new.Add([pscustomobject][ordered]@{
      id = $r.id
      time_utc = $r.ts
      time_local = ([datetime]::Parse($r.ts, $null, 'RoundtripKind')).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
      slot = $r.slot
      client = $r.client
      app = $r.app
      model = $r.model
      status = $r.status
      error_type = $r.error_type
      stream = $r.stream
      completed = $r.completed
      input_tokens = $r.input_tokens
      output_tokens = $r.output_tokens
      cache_creation_input_tokens = $r.cache_creation_input_tokens
      cache_read_input_tokens = $r.cache_read_input_tokens
      # The gateway prices each request when it records it (price list kept current from Anthropic's pricing page);
      # the local table only covers records from before it did.
      est_cost_usd = $(if ($null -ne $r.est_cost_usd) { [math]::Round([double]$r.est_cost_usd, 6) } else { Get-EstimatedCost $r })
      failovers = $r.failovers
      duration_ms = $r.duration_ms
      organization_id = $r.organization_id
      request_id = $r.request_id
      usage_json = $r.usage_json
    })
    $lastId = $r.id
  }
} while (@($page.rows).Count -eq 1000)
if ($new.Count -gt 0) {
  try {
    $new | Export-Csv -Path $csv -Append -NoTypeInformation -Encoding UTF8
  } catch {
    "Could not write $csv (is it open in Excel?). Close it and run again - nothing is lost."
    return
  }
}
"Downloaded $($new.Count) new record(s) -> $csv"

# --- Daily ledger: estimated credit used per key per UTC day -> usage\daily.csv.
# Rebuilt from usage.csv on every run, so a record that arrives late (a long stream finishing after
# midnight) still lands on the right day. cycle_to_date_usd restarts on each key's renewal day.
$all = @(@($existing); $new.ToArray())
if ($all.Count -eq 0) { 'No usage recorded yet.'; return }
$status = Invoke-RestMethod -Uri "$Base/gateway/status" -Headers $headers
$todayUtc = (Get-Date).ToUniversalTime().Date

function Get-CycleStart([datetime]$day, $renewDay) {
  if (-not $renewDay) { return $null }
  $inMonth = [math]::Min([int]$renewDay, [datetime]::DaysInMonth($day.Year, $day.Month))
  if ($day.Day -ge $inMonth) { return New-Object datetime $day.Year, $day.Month, $inMonth }
  $prev = (New-Object datetime $day.Year, $day.Month, 1).AddMonths(-1)
  return New-Object datetime $prev.Year, $prev.Month, ([math]::Min([int]$renewDay, [datetime]::DaysInMonth($prev.Year, $prev.Month)))
}

$totals = @{} # "yyyy-MM-dd|slot" -> sums
$firstDay = $todayUtc
foreach ($r in $all) {
  $day = [datetime]::Parse($r.time_utc, $null, 'RoundtripKind').ToUniversalTime().Date
  if ($day -lt $firstDay) { $firstDay = $day }
  $key = '{0:yyyy-MM-dd}|{1}' -f $day, $r.slot
  if (-not $totals.ContainsKey($key)) {
    $totals[$key] = @{ requests = 0; errors = 0; input = 0.0; output = 0.0; cache_write = 0.0; cache_read = 0.0; cost = 0.0 }
  }
  $t = $totals[$key]
  $t.requests += 1
  if ($r.status -ne '200') { $t.errors += 1 }
  $t.input += [double]$r.input_tokens
  $t.output += [double]$r.output_tokens
  $t.cache_write += [double]$r.cache_creation_input_tokens
  $t.cache_read += [double]$r.cache_read_input_tokens
  $t.cost += [double]$r.est_cost_usd
}

$slotInfo = @{}
foreach ($k in $status.keys) { $slotInfo[[string]$k.slot] = $k }
$slots = @(@($status.keys | ForEach-Object { [string]$_.slot }) + @($all | ForEach-Object { [string]$_.slot }) |
  Where-Object { $_ } | Sort-Object { [int]$_ } -Unique)

$ledger = New-Object System.Collections.Generic.List[object]
foreach ($slot in $slots) {
  $info = $slotInfo[$slot]
  $renewDay = $null
  $orgId = ''
  if ($info) { $renewDay = $info.credit_expiry_day; $orgId = $info.organization_id }
  $cycleStart = $null
  $cycleTotal = 0.0
  for ($day = $firstDay; $day -le $todayUtc; $day = $day.AddDays(1)) {
    $t = $totals['{0:yyyy-MM-dd}|{1}' -f $day, $slot]
    if (-not $t) { $t = @{ requests = 0; errors = 0; input = 0.0; output = 0.0; cache_write = 0.0; cache_read = 0.0; cost = 0.0 } }
    $start = Get-CycleStart $day $renewDay
    if ($start -ne $cycleStart) { $cycleStart = $start; $cycleTotal = 0.0 }
    $cycleTotal += $t.cost
    $ledger.Add([pscustomobject][ordered]@{
      date_utc = '{0:yyyy-MM-dd}' -f $day
      slot = [int]$slot
      requests = $t.requests
      errors = $t.errors
      input_tokens = $t.input
      output_tokens = $t.output
      cache_write_tokens = $t.cache_write
      cache_read_tokens = $t.cache_read
      est_cost_usd = [math]::Round($t.cost, 6)
      cycle_start_utc = $(if ($cycleStart) { '{0:yyyy-MM-dd}' -f $cycleStart } else { '' })
      cycle_to_date_usd = $(if ($cycleStart) { [math]::Round($cycleTotal, 6) } else { '' })
      organization_id = $orgId
    })
  }
}
$dailyCsv = Join-Path $dir 'daily.csv'
try {
  $ledger | Sort-Object date_utc, slot | Export-Csv -Path $dailyCsv -NoTypeInformation -Encoding UTF8
  "Daily credit ledger ($($ledger.Count) rows) -> $dailyCsv"
} catch {
  "Could not write $dailyCsv (is it open in Excel?). Close it and run again."
}


# --- Dashboard snapshot: usage\report.html, the online dashboard with its data saved in, for offline viewing.
# The dashboard is public; if it is made private again (DASHBOARD_KEY secret), the key in DASHBOARD_LINK.txt is used.
$dashHeaders = @{}
$linkFile = Join-Path $PSScriptRoot 'DASHBOARD_LINK.txt'
if ((Test-Path $linkFile) -and ((Get-Content -Raw $linkFile) -match 'key=([^\s&]+)')) { $dashHeaders['x-api-key'] = $Matches[1] }
$response = Invoke-WebRequest -UseBasicParsing -Uri "$Base/dashboard/data" -Headers $dashHeaders
$raw = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
$snapshot = $raw -replace '"live":\s*true', '"live": false'
# liveUrl lets the saved page switch to live numbers whenever this computer is online.
$snapshot = '{"generatedLocal": "' + (Get-Date -Format 'yyyy-MM-dd HH:mm') + '", "liveUrl": "' + $Base + '", ' + $snapshot.TrimStart().Substring(1)
# '</' is escaped so nothing in the data (app names come from request headers) can close the <script> tag.
$snapshot = $snapshot.Replace('</', '<\/')
$template = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'report-template.html')
$report = Join-Path $dir 'report.html'
[IO.File]::WriteAllText($report, $template.Replace('/*__DATA__*/null', $snapshot), (New-Object System.Text.UTF8Encoding $false))

# --- Short console summary; the dashboard has the full picture.
$d = $raw | ConvertFrom-Json
''
foreach ($k in ($d.keys | Sort-Object priority)) {
  $state = 'standby'
  if ($k.outOfCreditUntil) { $state = "OUT OF CREDIT until $($k.outOfCreditUntil.Substring(0, 10))" }
  elseif ($k.health -and $k.health.state -ne 'ok') { $state = "CHECK FAILED: $($k.health.state)" }
  elseif ($k.priority -eq 1) { $state = 'in use' }
  $renew = 'renewal day not set'
  if ($k.nextRenewal) { $renew = "renews $($k.nextRenewal)" }
  'Key {0}: ${1:N2} of ${2} used this cycle ({3}) - {4}' -f $k.slot, $k.cycleToDate, $k.credit, $renew, $state
}
'Spending pace: ${0:N2}/day (last 7 days). Estimates cover gateway traffic only; Console > Billing is exact.' -f $d.burnPerDay
"Offline dashboard -> $report   (live: $Base/)"
