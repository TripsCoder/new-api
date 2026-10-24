package modelconfig

import (
	_ "embed"
	"errors"
	"sync"

	"github.com/QuantumNous/new-api/common"
)

//go:embed catalog.json
var catalogJSON []byte

// AoTian is projected by its own plugin build; the six-provider generator
// continues to own catalog.json and its existing initialization artifacts.
//
//go:embed aotian_video.catalog.json
var aotianCatalogJSON []byte

//go:embed fenglang_video.catalog.json
var fenglangCatalogJSON []byte
var catalogOnce sync.Once
var catalogs map[string]any
var catalogError error

// ProviderCatalog returns source-backed public documentation, not an account
// model discovery result or an effective account price.
func ProviderCatalog(key string) (any, error) {
	catalogOnce.Do(func() {
		var root struct {
			Providers map[string]any `json:"providers"`
		}
		catalogError = common.Unmarshal(catalogJSON, &root)
		catalogs = root.Providers
		if catalogError != nil {
			return
		}
		var aotian map[string]any
		catalogError = common.Unmarshal(aotianCatalogJSON, &aotian)
		if catalogError == nil {
			catalogs["aotian_video"] = aotian
		}
		if catalogError != nil {
			return
		}
		var fenglang map[string]any
		catalogError = common.Unmarshal(fenglangCatalogJSON, &fenglang)
		if catalogError == nil {
			catalogs["fenglang_video"] = fenglang
		}
	})
	if catalogError != nil {
		return nil, catalogError
	}
	value, exists := catalogs[key]
	if !exists {
		return nil, errors.New("provider documentation catalog not found")
	}
	return value, nil
}
