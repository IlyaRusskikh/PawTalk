Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"
; Fixed phase names only. Never write captured invitation/password output here.
!macro InstallStage TEXT
 WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallStatus" "${TEXT}"
 FileOpen $R0 "$INSTDIR\install-status.txt" w
 FileWrite $R0 "${TEXT}"
 FileClose $R0
!macroend
!macro RemovalFailure STEP
 DetailPrint "${STEP} failed (exit $0)"
 IfSilent +2
 MessageBox MB_ICONSTOP "$(RemoveFailure)$\r$\n${STEP}: $0"
 SetErrorLevel 1
 Abort
!macroend
!ifdef TUI_ONLY
 !define ManagerName "PawTalk Server Manager (TUI)"
 !define InstallHelper "pawtalkctl.exe"
!else
 !define ManagerName "PawTalk Server Manager"
 !define InstallHelper "pawtalk-server-tray.exe"
!endif
!macro InstallCommand COMMAND TARGET
 !ifdef TUI_ONLY
  nsExec::Exec /TIMEOUT=600000 '"$PLUGINSDIR\${InstallHelper}" ${COMMAND} "${TARGET}"'
  Pop $0
 !else
  ExecWait '"$PLUGINSDIR\${InstallHelper}" ${COMMAND} "${TARGET}"' $0
 !endif
!macroend
Name "${ManagerName}"
OutFile "${OUTPUT}"
InstallDir "$APPDATA\PawTalk Server Manager"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
!define MUI_ICON "${STAGE}\server.ico"
!define MUI_UNICON "${STAGE}\server.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!ifndef TUI_ONLY
!define MUI_FINISHPAGE_RUN "$INSTDIR\pawtalk-server-tray.exe"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchTray
!define MUI_FINISHPAGE_RUN_TEXT "$(TrayRun)"
!endif
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataCreate un.DataLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"
Var Dialog
Var LanguageValue
Var DataRoot
Var DeleteField
Var DeleteData
Var PreviousInstall
LangString DeleteTitle ${LANG_ENGLISH} "Settings and room data"
LangString DeleteTitle ${LANG_RUSSIAN} "Настройки и данные комнаты"
LangString DeleteOption ${LANG_ENGLISH} "Delete settings and data (including room history, keys and backups)"
LangString DeleteOption ${LANG_RUSSIAN} "Удалить настройки и данные (включая историю комнаты, ключи и резервные копии)"
LangString DeleteNotice ${LANG_ENGLISH} "Program files and Windows services will be removed. Leave the checkbox clear to keep your room for reinstallation. Selected data deletion cannot be undone."
LangString DeleteNotice ${LANG_RUSSIAN} "Файлы программы и службы Windows будут удалены. Не отмечайте чекбокс, чтобы сохранить комнату для переустановки. Удаление выбранных данных необратимо."
LangString TrayRun ${LANG_ENGLISH} "Show PawTalk Server in the tray"
LangString TrayRun ${LANG_RUSSIAN} "Показать PawTalk Server в трее"
LangString Failure ${LANG_ENGLISH} "Manager installation failed. Existing Server data has been preserved."
LangString RemoveFailure ${LANG_ENGLISH} "Removal could not finish. Existing files and room data have been preserved. Open Diagnostics in Manager settings, then run the uninstaller again."
LangString RemoveFailure ${LANG_RUSSIAN} "Не удалось завершить удаление. Существующие файлы и данные комнаты сохранены. Откройте «Диагностику» в настройках Manager, затем повторите удаление."
LangString Failure ${LANG_RUSSIAN} "Не удалось установить Manager. Существующие данные сервера сохранены."

Function .onInit
 SetRegView 64
 SetShellVarContext all
 StrCpy $INSTDIR "$APPDATA\PawTalk Server Manager"
 ReadRegStr $PreviousInstall HKLM "Software\PawTalk\ServerManager" "InstallDir"
 ReadRegStr $DataRoot HKLM "Software\PawTalk\ServerManager" "DataRoot"
 ${If} $DataRoot == ""
  StrCpy $DataRoot "$APPDATA\PawTalk"
 ${EndIf}
 ${GetParameters} $0
 ${GetOptions} $0 "/ROOT=" $1
 ${If} $1 != ""
  StrCpy $DataRoot "$1"
 ${EndIf}
 ${IfNot} ${RunningX64}
  MessageBox MB_ICONSTOP "Windows x64 is required."
  Abort
 ${EndIf}
 ${IfNot} ${AtLeastWin10}
  MessageBox MB_ICONSTOP "Windows 10 / Windows Server 2019 or newer is required."
  Abort
 ${EndIf}
 IfSilent silentLanguage
 !insertmacro MUI_LANGDLL_DISPLAY
 Goto languageReady
 silentLanguage:
 ClearErrors
 ReadRegDWORD $0 HKLM "Software\PawTalk\ServerManager" "Language"
 ${IfNot} ${Errors}
  StrCpy $LANGUAGE $0
 ${EndIf}
 languageReady:
 StrCpy $LanguageValue "en"
 ${If} $LANGUAGE == ${LANG_RUSSIAN}
  StrCpy $LanguageValue "ru"
 ${EndIf}
FunctionEnd

!ifndef TUI_ONLY
Function LaunchTray
 Exec '"$INSTDIR\pawtalk-server-tray.exe" --tray-control settings "$DataRoot" $LanguageValue'
FunctionEnd
!endif

Section "PawTalk Server Manager"
 ; Use the new helper: older installed hosts do not know close-tray.
 InitPluginsDir
 SetOutPath "$PLUGINSDIR"
 File "/oname=${InstallHelper}" "${STAGE}\${InstallHelper}"
 !insertmacro InstallCommand "--server-stopped" "$DataRoot"
 ${If} $0 == 0
  System::Call 'kernel32::SetEnvironmentVariableW(w "PAWTALK_INSTALL_KEEP_STOPPED", w "1")'
 ${EndIf}
 WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallStatus" "close-tray"
 !ifdef TUI_ONLY
 !insertmacro InstallCommand "--close-tray" "$DataRoot"
 !else
 !insertmacro InstallCommand "--close-tray-for-upgrade" "$DataRoot"
 !endif
 ${If} $0 != 0
  WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallStatus" "close-tray failed (exit $0)"
  SetErrorLevel 1
  Abort
 ${EndIf}
 !insertmacro InstallCommand "--uninstall-services" "$DataRoot"
 ${If} $0 != 0
  WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallStatus" "uninstall-services failed (exit $0)"
  SetErrorLevel 1
  Abort
 ${EndIf}
 !insertmacro InstallCommand "--prepare-install" "$INSTDIR"
 ${If} $0 != 0
  WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallStatus" "prepare-install failed (exit $0)"
  SetErrorLevel 1
  Abort
 ${EndIf}
 SetOutPath "$INSTDIR"
 !ifdef TUI_ONLY
 File /r /x server.ico /x tui-version.json "${STAGE}\*"
 !else
 File /r "${STAGE}\*"
 !endif
 !insertmacro InstallStage "protect-install"
 ExecWait '"$INSTDIR\pawtalkctl.exe" protect-install "$INSTDIR"' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 !ifdef TUI_ONLY
 !insertmacro InstallStage "tui-host-self-test"
 nsExec::Exec /TIMEOUT=60000 '"$INSTDIR\pawtalkctl.exe" --root "$DataRoot" --self-test'
 Pop $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 !insertmacro InstallStage "remove-desktop"
 nsExec::Exec /TIMEOUT=600000 '"$INSTDIR\pawtalkctl.exe" --remove-desktop "$INSTDIR"'
 Pop $0
 ${If} $0 != 0
  !insertmacro InstallStage "remove-desktop failed (exit $0)"
  SetErrorLevel 1
  Abort
 ${EndIf}
 File "${STAGE}\tui-version.json"
 Delete "$SMPROGRAMS\PawTalk Server Manager\Status.lnk"
 Delete "$SMPROGRAMS\PawTalk Server Manager\Configure.lnk"
 Delete "$SMPROGRAMS\PawTalk Server Manager\PawTalk Server.lnk"
 Delete "$DESKTOP\PawTalk Server.lnk"
 Delete "$SMSTARTUP\PawTalk Server.lnk"
 RMDir "$SMPROGRAMS\PawTalk Server Manager"
 !else
 CreateDirectory "$SMPROGRAMS\PawTalk Server Manager"
 !insertmacro InstallStage "gui-host-self-test"
 ExecWait '"$INSTDIR\pawtalk-server-tray.exe" --self-test' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 Delete "$SMPROGRAMS\PawTalk Server Manager\Status.lnk"
 CreateShortcut "$SMPROGRAMS\PawTalk Server Manager\Configure.lnk" "$INSTDIR\pawtalk-server-tray.exe" '--tray-control settings "$DataRoot" $LanguageValue'
 ClearErrors
 Delete "$INSTDIR\tui-version.json"
 IfFileExists "$INSTDIR\tui-version.json" 0 +3
  SetErrorLevel 1
  Abort
 !endif
 ${If} $LanguageValue == ""
  StrCpy $LanguageValue "en"
 ${EndIf}
 ; Install only the Manager host/UI. No Server archive, configuration wizard or network.
 ; Server setup is an explicit operation in Manager UI.
 ; Never log the captured administrator invitation into the installer details.
 !insertmacro InstallStage "manager-install"
 nsExec::ExecToStack /TIMEOUT=600000 '"$INSTDIR\pawtalkctl.exe" --root "$DataRoot" --lang $LanguageValue manager-install'
 Pop $0
 Pop $1
 ${If} $0 != 0
  !insertmacro InstallStage "manager-install failed (exit $0)"
  SetErrorLevel 1
  IfSilent failed
  MessageBox MB_ICONSTOP "$(Failure)"
  failed:
  Abort
 ${EndIf}
 WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallDir" "$INSTDIR"
 WriteRegStr HKLM "Software\PawTalk\ServerManager" "DataRoot" "$DataRoot"
 WriteRegDWORD HKLM "Software\PawTalk\ServerManager" "Language" $LANGUAGE
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 !insertmacro InstallStage "protect-uninstaller"
 ExecWait '"$INSTDIR\pawtalkctl.exe" protect-install "$INSTDIR"' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager" "DisplayName" "${ManagerName}"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager" "DisplayVersion" "${VERSION}"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager" "UninstallString" '"$INSTDIR\Uninstall.exe"'
 !ifndef TUI_ONLY
 CreateShortcut "$SMPROGRAMS\PawTalk Server Manager\PawTalk Server.lnk" "$INSTDIR\pawtalk-server-tray.exe" '--root "$DataRoot" --lang $LanguageValue' "$INSTDIR\server.ico"
 !endif
 ${If} $PreviousInstall == "$PROGRAMFILES64\PawTalk Server Manager"
  !insertmacro InstallCommand "--retire-legacy" "$PreviousInstall"
  ${If} $0 != 0
   DetailPrint "Legacy program directory preserved for manual review. Room data remains in ProgramData."
  ${EndIf}
 ${EndIf}
 !insertmacro InstallStage "complete"
SectionEnd

Function un.onInit
 SetRegView 64
 SetShellVarContext all
 ReadRegStr $DataRoot HKLM "Software\PawTalk\ServerManager" "DataRoot"
 ReadRegDWORD $LANGUAGE HKLM "Software\PawTalk\ServerManager" "Language"
 ${If} $DataRoot == ""
  MessageBox MB_ICONSTOP "Missing PawTalk data-root registration. Removal cancelled."
  Abort
 ${EndIf}
 StrCpy $DeleteData ${BST_UNCHECKED}
 ${GetParameters} $0
 ${GetOptions} $0 "/DELETE-DATA" $1
 IfErrors +2
 StrCpy $DeleteData ${BST_CHECKED}
FunctionEnd

Function un.DataCreate
 !insertmacro MUI_HEADER_TEXT "$(DeleteTitle)" "PawTalk Server"
 nsDialogs::Create 1018
 Pop $Dialog
 ${NSD_CreateCheckbox} 0 8u 100% 34u "$(DeleteOption)"
 Pop $DeleteField
 ${NSD_SetState} $DeleteField $DeleteData
 ${NSD_CreateLabel} 0 60u 100% 65u "$(DeleteNotice)"
 Pop $0
 nsDialogs::Show
FunctionEnd

Function un.DataLeave
 ${NSD_GetState} $DeleteField $DeleteData
FunctionEnd

Section "Uninstall"
 SetRegView 64
 SetShellVarContext all
 ReadRegStr $DataRoot HKLM "Software\PawTalk\ServerManager" "DataRoot"
 ExecWait '"$INSTDIR\pawtalkctl.exe" close-tray "$DataRoot"' $0
 ${If} $0 != 0
  !insertmacro RemovalFailure "close-tray"
 ${EndIf}
 ExecWait '"$INSTDIR\pawtalkctl.exe" validate-install-removal "$INSTDIR"' $0
 ${If} $0 != 0
  !insertmacro RemovalFailure "validate-install-removal"
 ${EndIf}
 ExecWait '"$INSTDIR\pawtalkctl.exe" uninstall-services "$DataRoot"' $0
 ${If} $0 != 0
  !insertmacro RemovalFailure "uninstall-services"
 ${EndIf}
 ${If} $DeleteData == ${BST_CHECKED}
  ExecWait '"$INSTDIR\pawtalkctl.exe" purge-data "$DataRoot"' $0
  ${If} $0 != 0
   !insertmacro RemovalFailure "purge-data"
  ${EndIf}
  DeleteRegKey HKLM "Software\PawTalk\ServerManager"
 ${EndIf}
 Delete "$SMPROGRAMS\PawTalk Server Manager\Status.lnk"
 Delete "$SMPROGRAMS\PawTalk Server Manager\Configure.lnk"
 Delete "$SMPROGRAMS\PawTalk Server Manager\PawTalk Server.lnk"
 Delete "$DESKTOP\PawTalk Server.lnk"
 Delete "$SMSTARTUP\PawTalk Server.lnk"
 RMDir "$SMPROGRAMS\PawTalk Server Manager"
 DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager"
 SetOutPath "$TEMP"
 ; validate-install-removal checked this exact tree and refused reparse points.
 RMDir /r /REBOOTOK "$INSTDIR"
SectionEnd
