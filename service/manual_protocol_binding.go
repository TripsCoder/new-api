package service

import (
	"context"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"slices"
	"strings"
)

// ManualProtocolCandidates never publishes guessed model capabilities. Only a
// saved, confirmed, enabled binding on an enabled task channel participates.
// Ordinary channel/group/model authorization and final per-channel validation
// still run after endpoint pinning. Discovery results are deliberately absent.
func ManualProtocolCandidates(ctx context.Context, generation *pluginruntime.RoutingGeneration, method, path, name string, channelID int) []pluginruntime.ProtocolBinding {
	if model.DB == nil || generation == nil {
		return nil
	}
	var channels []model.Channel
	query := model.DB.WithContext(ctx).Select("id, type, status, models, setting").Where("type = ? AND status = ?", 61, 1)
	if channelID > 0 {
		query = query.Where("id = ?", channelID)
	}
	if query.Limit(1000).Find(&channels).Error != nil {
		return nil
	}
	result := []pluginruntime.ProtocolBinding{}
	seen := map[string]bool{}
	for _, ch := range channels {
		if !slices.Contains(strings.Split(ch.Models, ","), name) {
			continue
		}
		document, err := model.GetChannelModelConfiguration(ctx, ch.Id, 0)
		if err != nil {
			continue
		}
		plugin, ok := generation.Get(document.Provider)
		if !ok || !modelconfig.ReviewedPluginVersion(plugin.Meta.Version) || ch.GetSetting().TaskPluginKey != document.Provider {
			continue
		}
		for mode := range document.Bindings[name] {
			manual := modelconfig.ManualProtocolFor(document, name, mode)
			if manual == nil {
				continue
			}
			endpoint, ok := generation.LookupEndpoint(method, path, modelconfig.CanonicalReviewedModelName(document.Provider, manual.TemplateModel))
			if strings.HasPrefix(manual.TemplateModel, "interface:") {
				lookupMode := mode
				if _, supplemented := manual.Supplement[mode]; supplemented {
					lookupMode = "text_video"
					if strings.HasSuffix(mode, "image") {
						lookupMode = "text_image"
					}
				}
				endpoint, ok = generation.LookupConfiguredInterface(document.Provider, manual.TemplateModel, lookupMode, method, path, name)
			}
			// Shared template names can belong to multiple providers.
			for _, candidate := range generation.LookupEndpointCandidates(method, path, modelconfig.CanonicalReviewedModelName(document.Provider, manual.TemplateModel)) {
				if candidate.Plugin == plugin {
					endpoint = candidate
					ok = true
					break
				}
			}
			if !ok || endpoint.Plugin != plugin {
				continue
			}
			if (mode == "edit_image") != (endpoint.Operation.Name == "edit") {
				continue
			}
			if (strings.HasSuffix(mode, "image")) != (endpoint.Protocol == "openai_image") {
				continue
			}
			if seen[plugin.Meta.Key] {
				continue
			}
			endpoint.Model = name
			endpoint.ConfigurationBound = true
			result = append(result, endpoint)
			seen[plugin.Meta.Key] = true
		}
	}
	return result
}
