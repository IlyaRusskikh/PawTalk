//go:build windows

package main

import (
	"encoding/base64"
	"net"
	"net/url"
	"strconv"
	"strings"
)

func validInitialInvitation(value string) bool {
	if len(value) > 14000 {
		return false
	}
	address, err := url.Parse(value)
	if err != nil || address.Scheme != "pawtalk" || address.User != nil || address.RawQuery != "" || address.ForceQuery || address.RawPath != "" || address.Opaque != "" || net.ParseIP(address.Hostname()) == nil {
		return false
	}
	port, err := strconv.Atoi(address.Port())
	if err != nil || port < 1024 || port > 65532 || len(address.Path) != 65 || !strings.HasPrefix(address.Path, "/") || strings.Trim(address.Path[1:], "0123456789abcdef") != "" {
		return false
	}
	values, err := url.ParseQuery(address.Fragment)
	if err != nil || len(values) != 5 {
		return false
	}
	for _, key := range []string{"v", "setup", "server", "invite", "token"} {
		if len(values[key]) != 1 {
			return false
		}
	}
	for _, key := range []string{"server", "invite"} {
		if len(values.Get(key)) != 32 || strings.Trim(values.Get(key), "0123456789abcdef") != "" {
			return false
		}
	}
	token, err := base64.RawURLEncoding.Strict().DecodeString(values.Get("token"))
	return err == nil && len(token) == 32 && values.Get("v") == "2" && values.Get("setup") == "1"
}
