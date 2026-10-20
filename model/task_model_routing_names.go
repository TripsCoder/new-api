package model

import (
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"slices"
)

// Case aliases are pooled only for a pinned task-plugin request. Ordinary model
// and token matching is unchanged; provider/group/path constraints still apply.
func taskRoutingModelNames(name string, filters []dto.ChannelFilter) []string {
	names := []string{name}
	taskScoped := false
	for _, filter := range filters {
		if filter.Kind == dto.FilterTaskPluginIdentity && filter.TaskPluginKey != "" {
			taskScoped = true
			break
		}
	}
	if !taskScoped {
		return names
	}
	generation := jsplugin.DefaultRegistry.Generation()
	for _, declared := range generation.RoutingModelNames(name) {
		if !slices.Contains(names, declared) {
			names = append(names, declared)
		}
	}
	return names
}
