Unicode true
!include "LogicLib.nsh"
!include "x64.nsh"

Name "Dama"
Icon "Dama.ico"
UninstallIcon "Dama.ico"
OutFile "Dama-Setup.exe"
InstallDir "$PROGRAMFILES64\Dama"
RequestExecutionLevel admin
ShowInstDetails show
Page components
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Dama and automatic startup"
    SectionIn RO
    SetRegView 64
    SetOutPath "$INSTDIR"
    File "manage.ps1"
    File "manage.cmd"
    File "Dama.ico"
    SetOutPath "$INSTDIR\payload"
    File /r "payload\*"
    SetOutPath "$INSTDIR"
    WriteUninstaller "$INSTDIR\Uninstall.exe"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dama" "DisplayName" "Dama"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dama" "DisplayIcon" "$INSTDIR\Dama.ico"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dama" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dama" "NoModify" 1
    SetShellVarContext all
    CreateDirectory "$SMPROGRAMS\Dama"
    CreateShortCut "$SMPROGRAMS\Dama\Dama.lnk" "$INSTDIR\manage.cmd" "" "$INSTDIR\Dama.ico"
    CreateShortCut "$SMPROGRAMS\Dama\Uninstall Dama.lnk" "$INSTDIR\Uninstall.exe"
    ${DisableX64FSRedirection}
    ClearErrors
    ExecWait '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\manage.ps1" -Action Install' $0
    IfErrors 0 +2
        StrCpy $0 1
    ${EnableX64FSRedirection}
    ${If} $0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "Dama setup did not finish. Open Dama from the Start menu to repair or resume setup."
        SetErrorLevel $0
    ${EndIf}
SectionEnd

Section "Uninstall"
    SetRegView 64
    SetShellVarContext all
    ${DisableX64FSRedirection}
    ClearErrors
    ExecWait '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\manage.ps1" -Action Remove' $0
    IfErrors 0 +2
        StrCpy $0 1
    ${EnableX64FSRedirection}
    ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Dama could not stop its startup service. Use Dama to stop it and retry removal."
        SetErrorLevel $0
        Abort
    ${EndIf}
    Delete "$SMPROGRAMS\Dama\Dama.lnk"
    Delete "$SMPROGRAMS\Dama\Uninstall Dama.lnk"
    RMDir "$SMPROGRAMS\Dama"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dama"
    RMDir /r "$INSTDIR\payload"
    Delete "$INSTDIR\manage.ps1"
    Delete "$INSTDIR\manage.cmd"
    Delete "$INSTDIR\Dama.ico"
    Delete "$INSTDIR\Uninstall.exe"
    RMDir "$INSTDIR"
SectionEnd
