# Runs sync-usage.ps1 without a window (used by the scheduled task from install-auto-sync.ps1)
# and keeps the output of the latest run in usage\last-sync.log.
$log = Join-Path $PSScriptRoot 'usage\last-sync.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
& {
  "Sync started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  try {
    & (Join-Path $PSScriptRoot 'sync-usage.ps1')
  } catch {
    # Usually no network yet; the next sign-in or unlock tries again and nothing is lost.
    "Sync failed: $($_.Exception.Message)"
  }
} *>&1 | Out-File -FilePath $log -Encoding utf8
