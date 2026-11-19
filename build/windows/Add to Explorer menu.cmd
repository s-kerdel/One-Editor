@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Adds "Open with sec-edit" to the Explorer right-click menu (files, folders, folder background).
rem Current user only (HKCU) - no admin rights needed. Run it from the folder that contains sec-edit.exe.
set "EXE=%~dp0sec-edit.exe"
if not exist "%EXE%" (echo sec-edit.exe not found next to this script & pause & exit /b 1)
rem !EXE! (delayed expansion) keeps & ^ ( ) in the folder name literal; %EXE% would be re-parsed by cmd.
setlocal EnableDelayedExpansion
reg add "HKCU\Software\Classes\*\shell\sec-edit" /ve /d "Open with sec-edit" /f >nul
reg add "HKCU\Software\Classes\*\shell\sec-edit" /v Icon /d "\"!EXE!\"" /f >nul
reg add "HKCU\Software\Classes\*\shell\sec-edit\command" /ve /d "\"!EXE!\" \"%%1\"" /f >nul
reg add "HKCU\Software\Classes\Directory\shell\sec-edit" /ve /d "Open folder in sec-edit" /f >nul
reg add "HKCU\Software\Classes\Directory\shell\sec-edit" /v Icon /d "\"!EXE!\"" /f >nul
reg add "HKCU\Software\Classes\Directory\shell\sec-edit\command" /ve /d "\"!EXE!\" \"%%1\"" /f >nul
reg add "HKCU\Software\Classes\Directory\Background\shell\sec-edit" /ve /d "Open folder in sec-edit" /f >nul
reg add "HKCU\Software\Classes\Directory\Background\shell\sec-edit" /v Icon /d "\"!EXE!\"" /f >nul
reg add "HKCU\Software\Classes\Directory\Background\shell\sec-edit\command" /ve /d "\"!EXE!\" \"%%V\"" /f >nul
echo Done. Right-click a file or folder in Explorer: "Open with sec-edit".
echo (Windows 11: it is under "Show more options".)
pause
