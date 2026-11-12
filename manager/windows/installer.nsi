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
Name "PawTalk Server Manager"
OutFile "${OUTPUT}"
InstallDir "$APPDATA\PawTalk Server Manager"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
!define MUI_ICON "..\..\assets\server.ico"
!define MUI_UNICON "..\..\assets\server.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
Page custom SettingsCreate SettingsLeave
Page custom ShortcutsCreate ShortcutsLeave
!insertmacro MUI_PAGE_INSTFILES
Page custom InvitationCreate
!define MUI_FINISHPAGE_RUN "$INSTDIR\pawtalk-server-tray.exe"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchTray
!define MUI_FINISHPAGE_RUN_TEXT "$(TrayRun)"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataCreate un.DataLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"
Var Dialog
Var IP
Var Port
Var Encryption
Var Key
Var HistoryField
Var Auto
Var IPValue
Var PortValue
Var EncryptionValue
Var KeyValue
Var HistoryValue
Var AutoValue
Var LanguageValue
Var ExternalConfig
Var ExtraArgs
Var DataRoot
Var PauseArg
Var DesktopField
Var StartupField
Var DesktopValue
Var StartupValue
Var InviteField
Var DeleteField
Var DeleteData
Var PreviousInstall
LangString InviteTitle ${LANG_ENGLISH} "Room invitation"
LangString InviteTitle ${LANG_RUSSIAN} "Приглашение в комнату"
LangString InviteNotice ${LANG_ENGLISH} "This invitation includes the room password. Copy it into PawTalk or send it privately. If E2EE is enabled, share its secret key separately."
LangString InviteNotice ${LANG_RUSSIAN} "В приглашение включён пароль комнаты. Вставьте ссылку в PawTalk или отправьте лично. При включённом E2EE секретный ключ передаётся отдельно."
LangString InviteCopy ${LANG_ENGLISH} "Copy invitation with password"
LangString InviteCopy ${LANG_RUSSIAN} "Скопировать приглашение с паролем"
LangString InviteMissing ${LANG_ENGLISH} "The old password was not saved. Use 'Reset password and copy invitation' in the server tray menu. Resetting the password interrupts calls."
LangString InviteMissing ${LANG_RUSSIAN} "Старый пароль не сохранён. Выберите «Сменить пароль и скопировать приглашение» в меню сервера в трее. Смена пароля прерывает звонки."
LangString DeleteTitle ${LANG_ENGLISH} "Settings and room data"
LangString DeleteTitle ${LANG_RUSSIAN} "Настройки и данные комнаты"
LangString DeleteOption ${LANG_ENGLISH} "Delete settings and data (including room history, keys and backups)"
LangString DeleteOption ${LANG_RUSSIAN} "Удалить настройки и данные (включая историю комнаты, ключи и резервные копии)"
LangString DeleteNotice ${LANG_ENGLISH} "Program files and Windows services will be removed. Leave the checkbox clear to keep your room for reinstallation. Selected data deletion cannot be undone."
LangString DeleteNotice ${LANG_RUSSIAN} "Файлы программы и службы Windows будут удалены. Не отмечайте чекбокс, чтобы сохранить комнату для переустановки. Удаление выбранных данных необратимо."
LangString Shortcuts ${LANG_ENGLISH} "Server shortcuts"
LangString Shortcuts ${LANG_RUSSIAN} "Ярлыки сервера"
LangString DesktopOption ${LANG_ENGLISH} "Create a PawTalk Server shortcut on the desktop"
LangString DesktopOption ${LANG_RUSSIAN} "Создать ярлык PawTalk Server на рабочем столе"
LangString StartupOption ${LANG_ENGLISH} "Show the server in the tray when signing in to Windows"
LangString StartupOption ${LANG_RUSSIAN} "Показывать сервер в трее при входе в Windows"
LangString TrayRun ${LANG_ENGLISH} "Show PawTalk Server in the tray"
LangString TrayRun ${LANG_RUSSIAN} "Показать PawTalk Server в трее"
LangString TrayNotice ${LANG_ENGLISH} "The tray menu starts and stops the server. Choose 'Stop server and exit' to finish, or 'Close tray' to leave the Windows service running."
LangString TrayNotice ${LANG_RUSSIAN} "Меню в трее включает и отключает сервер. «Остановить сервер и выйти» завершает работу; «Закрыть значок» оставляет службу Windows работающей."
LangString Settings ${LANG_ENGLISH} "Server settings"
LangString Settings ${LANG_RUSSIAN} "Настройки сервера"
LangString Address ${LANG_ENGLISH} "Reachable public IPv4 / Base port"
LangString Address ${LANG_RUSSIAN} "Доступный публичный IPv4 / Основной порт"
LangString Encrypt ${LANG_ENGLISH} "Enable end-to-end encryption"
LangString Encrypt ${LANG_RUSSIAN} "Включить сквозное шифрование"
LangString Fingerprint ${LANG_ENGLISH} "SHA-256 key ID from the client (NOT the secret key)"
LangString Fingerprint ${LANG_RUSSIAN} "SHA-256 key ID из клиента (НЕ секретный ключ)"
LangString Chat ${LANG_ENGLISH} "History limit, MiB (0 = unlimited)"
LangString Chat ${LANG_RUSSIAN} "Лимит истории, МиБ (0 = без ограничения)"
LangString Updates ${LANG_ENGLISH} "Enable automatic server and maintenance updates"
LangString Updates ${LANG_RUSSIAN} "Включить автообновление сервера и средства обслуживания"
LangString Notice ${LANG_ENGLISH} "Server updates interrupt calls. Internet access requires reachable TCP/UDP ports."
LangString Notice ${LANG_RUSSIAN} "Обновление сервера прерывает звонок. Для интернета нужны доступные TCP/UDP порты."
LangString Failure ${LANG_ENGLISH} "Server setup failed. Use Status / Doctor to inspect the installation. Existing data has been preserved."
LangString RemoveFailure ${LANG_ENGLISH} "Removal could not finish. Existing files and room data have been preserved. Use Status / Doctor, then run the uninstaller again."
LangString RemoveFailure ${LANG_RUSSIAN} "Не удалось завершить удаление. Существующие файлы и данные комнаты сохранены. Откройте Status / Doctor, затем повторите удаление."
LangString Failure ${LANG_RUSSIAN} "Не удалось настроить сервер. Проверьте установку через Status / Doctor. Существующие данные сохранены."

Function .onInit
 SetRegView 64
 SetShellVarContext all
 StrCpy $INSTDIR "$APPDATA\PawTalk Server Manager"
 ReadRegStr $PreviousInstall HKLM "Software\PawTalk\ServerManager" "InstallDir"
 ReadRegStr $DataRoot HKLM "Software\PawTalk\ServerManager" "DataRoot"
 ${If} $DataRoot == ""
  StrCpy $DataRoot "$APPDATA\PawTalk"
 ${EndIf}
 StrCpy $PauseArg ""
 ${GetParameters} $0
 ${GetOptions} $0 "/ROOT=" $1
 ${If} $1 != ""
  StrCpy $DataRoot "$1"
 ${EndIf}
 ${GetOptions} $0 "/CONFIG=" $ExternalConfig
 ${If} $ExternalConfig == ""
  IfFileExists "$DataRoot\etc\pawtalk\config.env" 0 +2
  StrCpy $ExternalConfig "$DataRoot\etc\pawtalk\config.env"
 ${EndIf}
 StrCpy $ExtraArgs ""
 ${GetOptions} $0 "/TRUST=" $1
 ${If} $1 != ""
  StrCpy $ExtraArgs '$ExtraArgs --trust "$1"'
 ${EndIf}
 ${GetOptions} $0 "/SERVERMANIFEST=" $1
 ${If} $1 != ""
  StrCpy $ExtraArgs '$ExtraArgs --server-manifest "$1"'
 ${EndIf}
 ${GetOptions} $0 "/MANAGERMANIFEST=" $1
 ${If} $1 != ""
  StrCpy $ExtraArgs '$ExtraArgs --manager-manifest "$1"'
 ${EndIf}
 ${GetOptions} $0 "/BUNDLE=" $1
 ${If} $1 != ""
  StrCpy $ExtraArgs '$ExtraArgs --bundle "$1"'
 ${EndIf}
 ${GetOptions} $0 "/SERVERBUNDLE=" $1
 ${If} $1 != ""
  StrCpy $ExtraArgs '$ExtraArgs --server-bundle "$1"'
 ${EndIf}
 IfSilent 0 interactive
 StrCpy $PauseArg ""
 ${If} $ExternalConfig == ""
  SetErrorLevel 1
  Abort
 ${EndIf}
 interactive:
 ${IfNot} ${RunningX64}
  MessageBox MB_ICONSTOP "Windows x64 is required."
  Abort
 ${EndIf}
 ${IfNot} ${AtLeastWin10}
  MessageBox MB_ICONSTOP "Windows 10 / Windows Server 2019 or newer is required."
  Abort
 ${EndIf}
 !insertmacro MUI_LANGDLL_DISPLAY
 StrCpy $LanguageValue "en"
 ${If} $LANGUAGE == ${LANG_RUSSIAN}
  StrCpy $LanguageValue "ru"
 ${EndIf}
FunctionEnd

Function SettingsCreate
 ${If} $ExternalConfig != ""
  Abort
 ${EndIf}
 !insertmacro MUI_HEADER_TEXT "$(Settings)" "PawTalk Server Manager"
 nsDialogs::Create 1018
 Pop $Dialog
 ${NSD_CreateLabel} 0 0 100% 12u "$(Address)"
 Pop $0
 ${NSD_CreateText} 0 14u 68% 14u ""
 Pop $IP
 ${NSD_CreateText} 72% 14u 28% 14u "18443"
 Pop $Port
 ${NSD_CreateCheckbox} 0 37u 100% 12u "$(Encrypt)"
 Pop $Encryption
 ${NSD_Check} $Encryption
 ${NSD_OnClick} $Encryption EncryptionChanged
 ${NSD_CreateLabel} 0 55u 100% 12u "$(Fingerprint)"
 Pop $0
 ${NSD_CreateText} 0 69u 100% 14u ""
 Pop $Key
 ${NSD_CreateLabel} 0 92u 100% 12u "$(Chat)"
 Pop $0
 ${NSD_CreateText} 0 106u 100% 14u "128"
 Pop $HistoryField
 ${NSD_CreateCheckbox} 0 130u 100% 12u "$(Updates)"
 Pop $Auto
 ${NSD_Check} $Auto
 ${NSD_CreateLabel} 0 151u 100% 30u "$(Notice)"
 Pop $0
 nsDialogs::Show
FunctionEnd

Function LaunchTray
 Exec '"$INSTDIR\pawtalk-server-tray.exe" --root "$DataRoot" --lang $LanguageValue'
FunctionEnd

Function ShortcutsCreate
 !insertmacro MUI_HEADER_TEXT "$(Shortcuts)" "PawTalk Server"
 nsDialogs::Create 1018
 Pop $Dialog
 ${NSD_CreateCheckbox} 0 8u 100% 20u "$(DesktopOption)"
 Pop $DesktopField
 ${NSD_Check} $DesktopField
 ${NSD_CreateCheckbox} 0 38u 100% 20u "$(StartupOption)"
 Pop $StartupField
 ${NSD_Check} $StartupField
 ${NSD_CreateLabel} 0 74u 100% 60u "$(TrayNotice)"
 Pop $0
 nsDialogs::Show
FunctionEnd

Function ShortcutsLeave
 ${NSD_GetState} $DesktopField $DesktopValue
 ${NSD_GetState} $StartupField $StartupValue
FunctionEnd

Function EncryptionChanged
 ${NSD_GetState} $Encryption $0
 EnableWindow $Key $0
FunctionEnd

Function SettingsLeave
 ${If} $ExternalConfig != ""
  Return
 ${EndIf}
 ${NSD_GetText} $IP $IPValue
 ${NSD_GetText} $Port $PortValue
 ${NSD_GetText} $Key $KeyValue
 ${NSD_GetText} $HistoryField $HistoryValue
 ${NSD_GetState} $Encryption $0
 StrCpy $EncryptionValue "false"
 ${If} $0 == ${BST_CHECKED}
  StrCpy $EncryptionValue "true"
 ${Else}
  StrCpy $KeyValue ""
 ${EndIf}
 ${NSD_GetState} $Auto $0
 StrCpy $AutoValue "false"
 ${If} $0 == ${BST_CHECKED}
  StrCpy $AutoValue "true"
 ${EndIf}
 StrCpy $LanguageValue "en"
 ${If} $LANGUAGE == ${LANG_RUSSIAN}
  StrCpy $LanguageValue "ru"
 ${EndIf}
FunctionEnd

Section "PawTalk Server Manager"
 ; Use the new helper: older installed hosts do not know close-tray.
 InitPluginsDir
 SetOutPath "$PLUGINSDIR"
 File "/oname=pawtalk-server-tray.exe" "${STAGE}\pawtalk-server-tray.exe"
 WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallStatus" "close-tray"
 ExecWait '"$PLUGINSDIR\pawtalk-server-tray.exe" --close-tray "$DataRoot"' $0
 ${If} $0 != 0
  WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallStatus" "close-tray failed (exit $0)"
  SetErrorLevel 1
  Abort
 ${EndIf}
 ExecWait '"$PLUGINSDIR\pawtalk-server-tray.exe" --uninstall-services "$DataRoot"' $0
 ${If} $0 != 0
  WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallStatus" "uninstall-services failed (exit $0)"
  SetErrorLevel 1
  Abort
 ${EndIf}
 ExecWait '"$PLUGINSDIR\pawtalk-server-tray.exe" --prepare-install "$INSTDIR"' $0
 ${If} $0 != 0
  WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallStatus" "prepare-install failed (exit $0)"
  SetErrorLevel 1
  Abort
 ${EndIf}
 SetOutPath "$INSTDIR"
 File /r "${STAGE}\*"
 !insertmacro InstallStage "protect-install"
 ExecWait '"$INSTDIR\pawtalkctl.exe" protect-install "$INSTDIR"' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 CreateDirectory "$SMPROGRAMS\PawTalk Server Manager"
 !insertmacro InstallStage "gui-host-self-test"
 ExecWait '"$INSTDIR\pawtalk-server-tray.exe" --self-test' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 CreateShortcut "$SMPROGRAMS\PawTalk Server Manager\Status.lnk" "$INSTDIR\pawtalkctl.exe" '--elevate --pause --root "$DataRoot" status'
 CreateShortcut "$SMPROGRAMS\PawTalk Server Manager\Configure.lnk" "$INSTDIR\pawtalk-server-tray.exe" '--tray-control settings "$DataRoot" $LanguageValue'
 InitPluginsDir
 FileOpen $0 "$PLUGINSDIR\setup.env" w
 FileWrite $0 "PAWTALK_PUBLIC_IP=$IPValue$\nPAWTALK_PORT=$PortValue$\nPAWTALK_E2EE=$EncryptionValue$\nPAWTALK_E2EE_KEY_ID=$KeyValue$\nPAWTALK_CHAT_MAX_MB=$HistoryValue$\nPAWTALK_SERVER_AUTO_UPDATE=$AutoValue$\nPAWTALK_MANAGER_AUTO_UPDATE=$AutoValue$\nPAWTALK_LANGUAGE=$LanguageValue$\n"
 FileClose $0
 ${If} $ExternalConfig == ""
  StrCpy $ExternalConfig "$PLUGINSDIR\setup.env"
 ${EndIf}
 ${If} $LanguageValue == ""
  StrCpy $LanguageValue "en"
 ${EndIf}
 ; Capture output privately: the invitation has its own copyable wizard page.
 ; Never log the captured password-bearing output into the installer details.
 !insertmacro InstallStage "manager-install"
 nsExec::ExecToStack /TIMEOUT=600000 '"$INSTDIR\pawtalkctl.exe" --root "$DataRoot" --lang $LanguageValue install --config "$ExternalConfig" $ExtraArgs'
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
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager" "DisplayName" "PawTalk Server Manager"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager" "DisplayVersion" "${VERSION}"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager" "UninstallString" '"$INSTDIR\Uninstall.exe"'
 CreateShortcut "$SMPROGRAMS\PawTalk Server Manager\PawTalk Server.lnk" "$INSTDIR\pawtalk-server-tray.exe" '--root "$DataRoot" --lang $LanguageValue' "$INSTDIR\server.ico"
 ${If} $DesktopValue == ${BST_CHECKED}
  CreateShortcut "$DESKTOP\PawTalk Server.lnk" "$INSTDIR\pawtalk-server-tray.exe" '--root "$DataRoot" --lang $LanguageValue' "$INSTDIR\server.ico"
 ${EndIf}
 ${If} $StartupValue == ${BST_CHECKED}
  CreateShortcut "$SMSTARTUP\PawTalk Server.lnk" "$INSTDIR\pawtalk-server-tray.exe" '--root "$DataRoot" --lang $LanguageValue' "$INSTDIR\server.ico"
 ${Else}
  Delete "$SMSTARTUP\PawTalk Server.lnk"
 ${EndIf}
 ${If} $PreviousInstall == "$PROGRAMFILES64\PawTalk Server Manager"
  ExecWait '"$INSTDIR\pawtalk-server-tray.exe" --retire-legacy "$PreviousInstall"' $0
  ${If} $0 != 0
   DetailPrint "Legacy program directory preserved for manual review. Room data remains in ProgramData."
  ${EndIf}
 ${EndIf}
 !insertmacro InstallStage "complete"
SectionEnd

Function InvitationCreate
 !insertmacro MUI_HEADER_TEXT "$(InviteTitle)" "PawTalk Server"
 nsDialogs::Create 1018
 Pop $Dialog
 nsExec::ExecToStack /TIMEOUT=30000 '"$INSTDIR\pawtalkctl.exe" --root "$DataRoot" --lang $LanguageValue invitation --url'
 Pop $0
 Pop $1
 ${If} $0 == "0"
  ${NSD_CreateLabel} 0 0 100% 42u "$(InviteNotice)"
  Pop $0
  ${NSD_CreateText} 0 52u 100% 24u "$1"
  Pop $InviteField
  SendMessage $InviteField ${EM_SETREADONLY} 1 0
  ${NSD_CreateButton} 0 94u 100% 24u "$(InviteCopy)"
  Pop $0
  ${NSD_OnClick} $0 CopyInvitation
 ${Else}
  ${NSD_CreateLabel} 0 0 100% 70u "$(InviteMissing)"
  Pop $0
 ${EndIf}
 nsDialogs::Show
FunctionEnd

Function CopyInvitation
 SendMessage $InviteField ${EM_SETSEL} 0 -1
 SendMessage $InviteField ${WM_COPY} 0 0
FunctionEnd

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
