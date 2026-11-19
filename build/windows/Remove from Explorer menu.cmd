@echo off
rem Removes the "Open with sec-edit" Explorer entries added by "Add to Explorer menu.cmd".
reg delete "HKCU\Software\Classes\*\shell\sec-edit" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\shell\sec-edit" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\Background\shell\sec-edit" /f >nul 2>&1
echo Removed.
pause
