package modelconfig

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// UnifiedModel resolves the saved interface configuration by model, not by the
// optional references in one request. Modes remain an editing/history format.
// Conflicting saved rules are reported rather than picking a map iteration's
// price, default, mapping or constraint.
func UnifiedModel(document Document, model, operation string) (Mode, string, bool, error) {
	keys := make([]string, 0, len(document.Bindings[model]))
	for key := range document.Bindings[model] {
		if strings.HasSuffix(key, "image") == (operation == "image_generate" || operation == "image_edit") {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	result := Mode{Enabled: true, Input: map[string]any{}, Parameters: map[string]Parameter{}, Mapping: map[string]string{}}
	selected := ""
	for _, key := range keys {
		binding := document.Bindings[model][key]
		value, exists := document.Groups[binding.GroupID].Modes[key]
		if !exists || !value.Enabled || binding.Enabled != nil && !*binding.Enabled {
			continue
		}
		if binding.Protocol != nil {
			value.Protocol = binding.Protocol
		}
		if value.Protocol == nil || !strings.HasPrefix(value.Protocol.TemplateModel, "interface:") {
			return Mode{}, "", false, nil
		}
		if binding.Capabilities != nil {
			value.Capabilities = binding.Capabilities
		}
		if binding.Billing != nil {
			value.Billing = binding.Billing
		}
		if binding.Cost != nil {
			value.Cost = *binding.Cost
		}
		if selected == "" {
			result.Protocol, result.Cost = value.Protocol, value.Cost
			selected = key
		}
		if !reflect.DeepEqual(result.Protocol, value.Protocol) {
			return Mode{}, "", true, errors.New("model has conflicting configured interfaces")
		}
		if value.Billing != nil && value.Billing.Confirmed {
			if result.Billing != nil && (result.Billing.Currency != value.Billing.Currency || strings.TrimSpace(result.Billing.Expression) != strings.TrimSpace(value.Billing.Expression)) {
				return Mode{}, "", true, errors.New("model has different saved prices; confirm one model price before calling")
			}
			result.Billing = value.Billing
		}
		for field, parameter := range mergeParameters(value.Parameters, binding.Parameters) {
			if old, ok := result.Parameters[field]; ok && !reflect.DeepEqual(old, parameter) {
				return Mode{}, "", true, fmt.Errorf("model has conflicting saved parameter %s", field)
			}
			result.Parameters[field] = parameter
		}
		for field, value := range merge(value.Input, binding.Input) {
			if old, ok := result.Input[field]; ok && !reflect.DeepEqual(old, value) {
				return Mode{}, "", true, fmt.Errorf("model has conflicting saved default %s", field)
			}
			result.Input[field] = value
		}
		mapping := map[string]string{}
		for from, to := range value.Mapping {
			mapping[from] = to
		}
		for from, to := range binding.Mapping {
			mapping[from] = to
		}
		for from, to := range mapping {
			if old, ok := result.Mapping[from]; ok && old != to {
				return Mode{}, "", true, fmt.Errorf("model has conflicting saved mapping %s", from)
			}
			result.Mapping[from] = to
		}
		result.StrictMapping = result.StrictMapping || value.StrictMapping
		if c := value.Capabilities; c != nil {
			if result.Capabilities == nil {
				result.Capabilities = &InputCapabilities{}
			}
			result.Capabilities.Images = result.Capabilities.Images || c.Images
			result.Capabilities.Videos = result.Capabilities.Videos || c.Videos
			result.Capabilities.Audios = result.Capabilities.Audios || c.Audios
			result.Capabilities.FirstFrame = result.Capabilities.FirstFrame || c.FirstFrame
			result.Capabilities.LastFrame = result.Capabilities.LastFrame || c.LastFrame
		}
	}
	return result, selected, selected != "", nil
}

func ResolveUnified(document Document, model, operation string, request map[string]any, form bool) (map[string]any, Mode, string, bool, error) {
	definition, mode, unified, err := UnifiedModel(document, model, operation)
	if err != nil || !unified {
		return nil, definition, mode, unified, err
	}
	// Reuse the existing explicit default, policy, type and schema validator.
	scoped := Document{Format: Format, Provider: document.Provider, Revision: document.Revision,
		Groups:   map[string]Group{"unified": {Modes: map[string]Mode{mode: definition}}},
		Bindings: map[string]map[string]Binding{model: {mode: {GroupID: "unified"}}}}
	input, resolved, err := Resolve(scoped, model, mode, request, form)
	return input, resolved, mode, true, err
}
