@echo off
setlocal DisableDelayedExpansion
rem One in your browser: serves a folder on http://127.0.0.1 (port 4317+) and opens the browser.
rem   Double-click and type a folder, drag a folder onto this file, or:  "Start web server.cmd" C:\notes
rem Runs in One.exe itself, without a window - no Node.js install needed. Close this window (or Ctrl+C) to stop.
set "APP=%~dp0"
set "FOLDER=%~1"
if not defined FOLDER set /p "FOLDER=Folder to open in the browser (Enter = %USERPROFILE%\Documents): "
if not defined FOLDER set "FOLDER=%USERPROFILE%\Documents"
"%APP%One.exe" --serve "%FOLDER%" --open
if errorlevel 1 pause
