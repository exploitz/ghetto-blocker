# Registers a Scheduled Task that starts ghetto-blocker at logon (runs hidden,
# in the background). Run from a normal or elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#
# Remove it later with:
#   Unregister-ScheduledTask -TaskName 'ghetto-blocker' -Confirm:$false

$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $cmd) {
  Write-Error "npm.cmd not found on PATH. Install Node.js for Windows first."
  exit 1
}

$action = New-ScheduledTaskAction -Execute $cmd.Source -Argument 'start' -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName 'ghetto-blocker' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered scheduled task 'ghetto-blocker' (starts at logon)."
Write-Host "Working dir: $project"
