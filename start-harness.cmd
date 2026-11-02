@echo off
rem Optional wrapper: executable comes from private config or DSH_HARNESS_EXE.
rem Keep requireHarness=true; the notifier decides when Harness is running.
setlocal
call "%~dp0run-wechat-notify.cmd" --launch-harness
if errorlevel 1 exit /b 1
set "DSH_NOTIFY_LAUNCHER=%~dp0run-wechat-notify.cmd"
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "& $env:DSH_NOTIFY_LAUNCHER"
exit /b %errorlevel%
