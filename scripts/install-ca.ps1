#requires -RunAsAdministrator
# Installs the ghetto-blocker CA certificate into the Windows machine-wide
# "Trusted Root Certification Authorities" store, so Chromium browsers accept
# the certificates the proxy generates for intercepted HTTPS sites.
#
# Run from an ELEVATED PowerShell (headless):
#   powershell -ExecutionPolicy Bypass -File scripts\install-ca.ps1
#
# Electron invokes it with an explicit path:
#   powershell -ExecutionPolicy Bypass -File scripts\install-ca.ps1 -CaPath "C:\...\ca.pem"

param(
  # Optional: override the CA cert path.  Defaults to the standard per-user location.
  [string]$CaPath = (Join-Path $env:USERPROFILE '.ghetto-blocker\ca\certs\ca.pem')
)

$ErrorActionPreference = 'Stop'

$ca = $CaPath
if (-not (Test-Path $ca)) {
  Write-Error "CA not found at $ca`nStart ghetto-blocker once ('npm start') to generate it, then re-run this script."
  exit 1
}

Write-Host "Importing CA into Cert:\LocalMachine\Root ..."
Import-Certificate -FilePath $ca -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Write-Host "Done. Fully quit Vivaldi (verify in Task Manager) and reopen it so it reloads the root store."
