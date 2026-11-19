//go:build windows

package main

import (
	"golang.org/x/sys/windows/registry"
)

func serverUILanguage(fallback string) string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `Software\PawTalk\ServerManager`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return fallback
	}
	defer key.Close()
	value, _, err := key.GetIntegerValue("Language")
	if err == nil {
		if value == 1049 {
			return "ru"
		}
		if value == 1033 {
			return "en"
		}
	}
	return fallback
}
func notifyTrayLanguage(root, lang string) {
	window := trayCall("FindWindowW", wide(serverTrayClass(root)), 0)
	if window != 0 {
		value := 0
		if lang == "en" {
			value = 1
		}
		trayCall("PostMessageW", window, 0x8007, value, 0)
	}
}
