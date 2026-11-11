Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
Name "PawTalk Server Manager"
OutFile "${OUTPUT}"
InstallDir "$PROGRAMFILES64\PawTalk Server Manager"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
!define MUI_ICON "..\..\assets\pawtalk.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
Page custom SettingsCreate SettingsLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
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
LangString Failure ${LANG_ENGLISH} "Server setup failed. Review the console output. Existing data has been preserved."
LangString Failure ${LANG_RUSSIAN} "Не удалось настроить сервер. Проверьте вывод консоли. Существующие данные сохранены."

Function .onInit
 SetRegView 64
 ${If} $INSTDIR != "$PROGRAMFILES64\PawTalk Server Manager"
  MessageBox MB_ICONSTOP "Install Server Manager in its protected Program Files directory."
  Abort
 ${EndIf}
 SetShellVarContext all
 StrCpy $DataRoot "$APPDATA\PawTalk"
 StrCpy $PauseArg "--pause"
 ${GetParameters} $0
 ${GetOptions} $0 "/ROOT=" $DataRoot
 ${If} $DataRoot == ""
  StrCpy $DataRoot "$APPDATA\PawTalk"
 ${EndIf}
 ${GetOptions} $0 "/CONFIG=" $ExternalConfig
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
FunctionEnd

Function SettingsCreate
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

Function EncryptionChanged
 ${NSD_GetState} $Encryption $0
 EnableWindow $Key $0
FunctionEnd

Function SettingsLeave
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
 IfFileExists "$INSTDIR\pawtalkctl.exe" 0 fresh_install
 ; Explicit EXE maintenance can replace the stable host/runtime only while stopped.
 ExecWait '"$INSTDIR\pawtalkctl.exe" stop-manager "$DataRoot"' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 ExecWait '"$INSTDIR\pawtalkctl.exe" stop-server "$DataRoot"' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 fresh_install:
 SetOutPath "$INSTDIR"
 File /r "${STAGE}\*"
 ExecWait '"$INSTDIR\pawtalkctl.exe" protect-install "$INSTDIR"' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 CreateDirectory "$SMPROGRAMS\PawTalk Server Manager"
 CreateShortcut "$SMPROGRAMS\PawTalk Server Manager\Status.lnk" "$INSTDIR\pawtalkctl.exe" '--elevate --pause --root "$DataRoot" status'
 CreateShortcut "$SMPROGRAMS\PawTalk Server Manager\Configure.lnk" "$INSTDIR\pawtalkctl.exe" '--elevate --pause --root "$DataRoot" setup'
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
 ExecWait '"$INSTDIR\pawtalkctl.exe" $PauseArg --root "$DataRoot" --lang $LanguageValue install --config "$ExternalConfig" $ExtraArgs' $0
 ${If} $0 != 0
  SetErrorLevel 1
  IfSilent failed
  MessageBox MB_ICONSTOP "$(Failure)"
  failed:
  Abort
 ${EndIf}
 WriteRegStr HKLM "Software\PawTalk\ServerManager" "InstallDir" "$INSTDIR"
 WriteRegStr HKLM "Software\PawTalk\ServerManager" "DataRoot" "$DataRoot"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 ExecWait '"$INSTDIR\pawtalkctl.exe" protect-install "$INSTDIR"' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager" "DisplayName" "PawTalk Server Manager"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager" "DisplayVersion" "${VERSION}"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd

Section "Uninstall"
 SetRegView 64
 SetShellVarContext all
 ReadRegStr $DataRoot HKLM "Software\PawTalk\ServerManager" "DataRoot"
 ExecWait '"$INSTDIR\pawtalkctl.exe" --root "$DataRoot" uninstall --keep-data --yes' $0
 ${If} $0 != 0
  SetErrorLevel 1
  Abort
 ${EndIf}
 Delete "$SMPROGRAMS\PawTalk Server Manager\Status.lnk"
 Delete "$SMPROGRAMS\PawTalk Server Manager\Configure.lnk"
 RMDir "$SMPROGRAMS\PawTalk Server Manager"
 DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager"
 ; Keep binaries, configuration and backups for explicit recovery, like Linux --keep-data.
SectionEnd
