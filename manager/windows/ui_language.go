//go:build windows

package main

import (
	"golang.org/x/sys/windows/registry"
	"path/filepath"
	"strings"
)

func settingsLanguageRequest(values map[string]string, lang string) *settingsRequest {
	next := map[string]string{}
	for _, key := range []string{"PAWTALK_PUBLIC_IP", "PAWTALK_PORT", "PAWTALK_E2EE", "PAWTALK_E2EE_KEY_ID", "PAWTALK_CHAT_MAX_MB", "PAWTALK_SERVER_AUTO_UPDATE", "PAWTALK_MANAGER_AUTO_UPDATE", "PAWTALK_LANGUAGE"} {
		next[key] = values[key]
	}
	next["PAWTALK_LANGUAGE"] = lang
	return &settingsRequest{Expected: values, Values: next}
}
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
func saveUILanguage(root, lang string) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `Software\PawTalk\ServerManager`, registry.QUERY_VALUE|registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return
	}
	defer key.Close()
	registered, _, err := key.GetStringValue("DataRoot")
	if err != nil || !strings.EqualFold(filepath.Clean(registered), filepath.Clean(root)) {
		return
	}
	value := uint32(1033)
	if lang == "ru" {
		value = 1049
	}
	_ = key.SetDWordValue("Language", value)
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
