!macro customInstall
  ; Keep the installer choice beside the executable, not in an elevated user's profile.
  FileOpen $0 "$INSTDIR\language.json" w
  ${If} $LANGUAGE == 1049
    FileWrite $0 '{"language":"ru"}'
  ${Else}
    FileWrite $0 '{"language":"en"}'
  ${EndIf}
  FileClose $0
!macroend
