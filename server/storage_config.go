package main

import (
	"fmt"
	"math"
	"os"
	"strconv"
)

const defaultChatStorage = 128 * 1024 * 1024

func chatStorageLimit() (int64, error) {
	raw := os.Getenv("PAWTALK_CHAT_MAX_MB")
	if raw == "" {
		return defaultChatStorage, nil
	}
	mb, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || mb < 0 || mb > math.MaxInt64/(1024*1024) {
		return 0, fmt.Errorf("PAWTALK_CHAT_MAX_MB must be a non-negative integer (0 means unlimited)")
	}
	return mb * 1024 * 1024, nil
}
