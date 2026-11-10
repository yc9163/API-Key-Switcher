# Registers a Windows scheduled task that syncs usage automatically when you sign in and whenever you
# unlock the PC (e.g. after waking it from sleep). Re-run after moving this folder.
# Usage (inside this folder):  powershell -ExecutionPolicy Bypass -File .\install-auto-sync.ps1
# Remove it again:             powershell -ExecutionPolicy Bypass -File .\install-auto-sync.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$name = 'Claude gateway usage sync'
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  "Removed scheduled task '$name'."
  return
}
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$script = Join-Path $PSScriptRoot 'auto-sync.ps1'
# conhost --headless runs PowerShell with no window flashing up.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User $me
$logon.Delay = 'PT1M' # Give the network a minute after sign-in.
$unlockClass = Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskSessionStateChangeTrigger
$unlock = New-CimInstance -CimClass $unlockClass -ClientOnly -Property @{
  StateChange = [uint32]8 # TASK_SESSION_UNLOCK
  UserId = $me
  Delay = 'PT1M'
  Enabled = $true
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $unlock) -Settings $settings `
  -Principal $principal -Description 'Downloads Claude gateway usage into usage\usage.csv and usage\daily.csv.' -Force | Out-Null
"Registered scheduled task '$name' for $me (runs at sign-in and on unlock; output in usage\last-sync.log)."
