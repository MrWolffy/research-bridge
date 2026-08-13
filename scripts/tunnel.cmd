@echo off
setlocal

set "TUNNEL_ACTION=%~1"
if "%TUNNEL_ACTION%"=="" set "TUNNEL_ACTION=run"

if /I not "%TUNNEL_ACTION%"=="init" if /I not "%TUNNEL_ACTION%"=="doctor" if /I not "%TUNNEL_ACTION%"=="run" (
  echo Usage: tunnel.cmd [init^|doctor^|run]
  exit /b 2
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0secure-tunnel.ps1" -TunnelAction "%TUNNEL_ACTION%" -TunnelProfile "research-bridge"
exit /b %ERRORLEVEL%
