@echo off
set "DAMA_MANAGER=%~dp0manage.ps1"
powershell.exe -NoProfile -Command "Start-Process -Verb RunAs -FilePath powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File ' + [char]34 + $env:DAMA_MANAGER + [char]34)"
