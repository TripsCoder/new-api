package modelconfig

import (
	_ "embed"
	"errors"
	"sync"

	"github.com/QuantumNous/new-api/common"
)

//go:embed catalog.json
var catalogJSON []byte
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
