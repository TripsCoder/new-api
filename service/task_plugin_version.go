package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/QuantumNous/new-api/plugins"
	"sync"
)

// VersionedProviderTask applies only to the six rebuilt providers. Legacy
// platforms retain their existing adaptor policy. A missing historical snapshot
// must be reported by initialization rather than guessed from model names.
func VersionedProviderTask(task *model.Task) bool {
	return task != nil && task.PrivateData.Execution != nil && task.PrivateData.Execution.TaskPlugin != nil && modelconfig.SupportedProvider(task.PrivateData.Execution.TaskPlugin.Key) && task.PrivateData.Execution.TaskPlugin.Version != ""
}

type historicalPluginEntry struct {
	plugin *pluginruntime.LoadedPlugin
	used   uint64
}

var historicalPlugins = struct {
	sync.Mutex
	entries map[string]historicalPluginEntry
	clock   uint64
}{entries: map[string]historicalPluginEntry{}}

// ResolvePinnedTaskPlugin never substitutes the active version for a missing or
// changed submit-time source. It compiles retained immutable plugin rows without
// registering them for new submissions or replacing the live routing generation.
func ResolvePinnedTaskPlugin(task *model.Task) (*pluginruntime.LoadedPlugin, error) {
	if !VersionedProviderTask(task) || !pluginruntime.DefaultRegistry.Enabled() {
		return nil, errors.New("historical task plugin is unavailable")
	}
	snapshot := task.PrivateData.Execution.TaskPlugin
	if snapshot.Key != string(task.Platform) {
		return nil, errors.New("historical task plugin does not match the task platform")
	}
	cacheKey := snapshot.Key + "@" + snapshot.Version + "#" + snapshot.SourceSHA256
	historicalPlugins.Lock()
	historicalPlugins.clock++
	if entry, ok := historicalPlugins.entries[cacheKey]; ok {
		entry.used = historicalPlugins.clock
		historicalPlugins.entries[cacheKey] = entry
		historicalPlugins.Unlock()
		return entry.plugin, nil
	}
	historicalPlugins.Unlock()
	if current, ok := pluginruntime.DefaultRegistry.Get(snapshot.Key); ok && current.Meta.Version == snapshot.Version && snapshot.SourceSHA256 != "" && current.SourceSHA256 == snapshot.SourceSHA256 {
		return current, nil
	}
	source := ""
	if model.DB != nil {
		if row, err := model.GetTaskPluginVersion(snapshot.Key, snapshot.Version); err == nil {
			digest := sha256.Sum256([]byte(row.Source))
			hash := hex.EncodeToString(digest[:])
			if (snapshot.SourceSHA256 == "" && len(row.SourceHash) != 64) || row.SourceHash != "" && row.SourceHash != hash {
				return nil, errors.New("historical task plugin source digest changed")
			}
			source = string(row.Source)
		}
	}
	if source == "" {
		if snapshot.SourceSHA256 == "" {
			return nil, errors.New("version-only legacy snapshot requires a retained immutable database source")
		}
		var err error
		source, err = plugins.Source(snapshot.Key)
		if err != nil {
			return nil, errors.New("historical task plugin source was not retained")
		}
	}
	loaded, err := pluginruntime.CompilePlugin(source, pluginruntime.Options{Key: snapshot.Key, Version: snapshot.Version})
	if err != nil {
		return nil, errors.New("historical task plugin source could not be loaded")
	}
	if loaded.Meta.Key != snapshot.Key || loaded.Meta.Version != snapshot.Version || snapshot.SourceSHA256 != "" && loaded.SourceSHA256 != snapshot.SourceSHA256 {
		return nil, errors.New("historical task plugin source does not match its snapshot")
	}
	historicalPlugins.Lock()
	defer historicalPlugins.Unlock()
	historicalPlugins.clock++
	if len(historicalPlugins.entries) >= 32 {
		oldest := ""
		var age uint64
		for key, entry := range historicalPlugins.entries {
			if oldest == "" || entry.used < age {
				oldest = key
				age = entry.used
			}
		}
		delete(historicalPlugins.entries, oldest)
	}
	historicalPlugins.entries[cacheKey] = historicalPluginEntry{plugin: loaded, used: historicalPlugins.clock}
	return loaded, nil
}

// ReviewedProviderTask includes snapshotless legacy tasks so callers never
// accidentally fall back to today's plugin when provenance is unavailable.
func ReviewedProviderTask(task *model.Task) bool {
	return task != nil && (modelconfig.SupportedProvider(string(task.Platform)) || (task.PrivateData.Execution != nil && task.PrivateData.Execution.TaskPlugin != nil && modelconfig.SupportedProvider(task.PrivateData.Execution.TaskPlugin.Key)))
}
