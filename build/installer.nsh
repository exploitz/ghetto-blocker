; Custom NSIS hooks for the ghetto-blocker installer (electron-builder `nsis.include`).
;
; Uninstall: the app trusted its own certificate authority in the Windows root
; store so it could filter HTTPS. Leaving that behind after an uninstall would
; leave a trusted MITM CA on the machine, so remove it, together with the CA
; private key and the cached filter engines. Settings and user rules are kept
; so a reinstall picks them up.

!macro customUnInstall
  DetailPrint "Removing the ghetto-blocker certificate authority from the Windows trust store"
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Where-Object { $$_.Subject -like \"*NodeMITMProxyCA*\" } | Remove-Item -ErrorAction SilentlyContinue"'
  Pop $0
  DetailPrint "Removing the CA key and cached filter lists"
  RMDir /r "$PROFILE\.ghetto-blocker\ca"
  Delete "$PROFILE\.ghetto-blocker\engine.bin"
  Delete "$PROFILE\.ghetto-blocker\privacy.bin"
!macroend
