#requires -RunAsAdministrator
# Removes the ghetto-blocker CA certificate from the Windows Trusted Root store.
# Matches by the actual thumbprint read from the CA file (no hard-coded names).
#
# Run from an ELEVATED PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-ca.ps1

$ErrorActionPreference = 'Stop'

$ca = Join-Path $env:USERPROFILE '.ghetto-blocker\ca\certs\ca.pem'
if (-not (Test-Path $ca)) {
  Write-Error "CA file not found at $ca - cannot determine which certificate to remove."
  exit 1
}

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $ca
$thumbprint = $cert.Thumbprint
$found = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Thumbprint -eq $thumbprint }

if ($found) {
  $found | Remove-Item
  Write-Host "Removed CA (thumbprint $thumbprint) from Trusted Root."
} else {
  Write-Host "CA (thumbprint $thumbprint) was not in Trusted Root - nothing to remove."
}
