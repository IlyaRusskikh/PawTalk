package access

import (
	_ "embed"
	"encoding/json"
	"maps"
	"slices"
	"sort"
)

const (
	Everyone      = "@everyone"
	Administrator = "server.administrator"
	ChannelView   = "channel.view"
)

//go:embed catalog.json
var catalogJSON string

// CatalogJSON is also consumed by the client. Its IDs are independent of UI labels.
func CatalogJSON() string { return catalogJSON }

type permission struct {
	ID               string
	Scope            string
	Rank             string
	Default          bool
	Lift             bool
	BlockedByTimeout bool
	Requires         []string
}

var permissions, defaultGrants = loadCatalog()
var orderedPermissions = slices.Sorted(maps.Keys(permissions))

func loadCatalog() (map[string]permission, []string) {
	var catalog struct {
		Version     int
		Permissions []permission
	}
	if err := json.Unmarshal([]byte(catalogJSON), &catalog); err != nil || catalog.Version != 1 {
		panic("invalid access permission catalog")
	}
	index := make(map[string]permission, len(catalog.Permissions))
	var defaults []string
	for _, entry := range catalog.Permissions {
		if entry.ID == "" || index[entry.ID].ID != "" {
			panic("invalid or duplicate access permission")
		}
		index[entry.ID] = entry
		if entry.Default {
			defaults = append(defaults, entry.ID)
		}
	}
	sort.Strings(defaults)
	return index, defaults
}

func DefaultGrants() []string { return slices.Clone(defaultGrants) }
