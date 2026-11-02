@echo off
rem Use an explicit Node executable, the Harness runtime, or Node from PATH.
setlocal
set "NODE=%DSH_NOTIFY_NODE%"
if defined NODE goto :check_node
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE%" goto :run
where /q node.exe
if errorlevel 1 (
  echo Node.js 24 or later is required. Set DSH_NOTIFY_NODE or install Node on PATH. 1>&2
  exit /b 1
)
set "NODE=node.exe"
goto :run
:check_node
if not exist "%NODE%" (
  echo DSH_NOTIFY_NODE does not refer to an existing executable. 1>&2
  exit /b 1
)
:run
if /i "%~1"=="--launch-harness" goto :launch_harness
"%NODE%" "%~dp0dsh-wechat-notify.js" %*
exit /b %errorlevel%
:launch_harness
"%NODE%" "%~dp0scripts\launch-harness.js"
exit /b %errorlevel%
