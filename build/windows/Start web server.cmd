@echo off
setlocal DisableDelayedExpansion
rem sec-edit in your browser: serves a folder on http://127.0.0.1 (port 4317+) and opens the browser.
rem   Double-click and type a folder, drag a folder onto this file, or:  "Start web server.cmd" C:\notes
rem Uses sec-edit.exe in Node mode - no Node.js install needed. Close this window (or Ctrl+C) to stop.
set "APP=%~dp0"
set "FOLDER=%~1"
if not defined FOLDER set /p "FOLDER=Folder to open in the browser (Enter = %USERPROFILE%\Documents): "
if not defined FOLDER set "FOLDER=%USERPROFILE%\Documents"
set "ELECTRON_RUN_AS_NODE=1"
"%APP%sec-edit.exe" "%APP%resources\app.asar.unpacked\dist\server\cli.mjs" "%FOLDER%" --open
if errorlevel 1 pause
