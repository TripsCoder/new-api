package modelconfig

import (
	"fmt"
	"reflect"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

// Only the new interface flow canonicalizes its documented aliases before the
// existing send/reject/ignore policy, so an alias cannot bypass that policy.
func normalizeInterfaceAliases(input map[string]any, parameters map[string]Parameter) (map[string]any, error) {
	result := cloneMap(input)
	if images, exists := parameters["images"]; exists {
		metadata, _ := images.Definition["x-channel-parameter"].(map[string]any)
		encoding, _ := metadata["frameEncoding"].(map[string]any)
		first, firstOK := result["start_image_url"]
		last, lastOK := result["end_image_url"]
		if len(encoding) > 0 && (firstOK || lastOK) {
			if _, ok := result["images"]; ok {
				return nil, fmt.Errorf("frame controls conflict with reference images")
			}
			if !firstOK && encoding["requiresFirstForLast"] == true {
				return nil, fmt.Errorf("a documented last frame requires a first frame")
			}
			role, _ := encoding["roleField"].(string)
			refs := []any{}
			if firstOK {
				refs = append(refs, map[string]any{"url": first, role: encoding["firstRole"]})
			}
			if lastOK {
				refs = append(refs, map[string]any{"url": last, role: encoding["lastRole"]})
			}
			result["images"] = refs
			delete(result, "start_image_url")
			delete(result, "end_image_url")
		}
	}
	if _, flag := parameters["first_last_frame"]; flag {
		first, firstOK := result["start_image_url"]
		last, lastOK := result["end_image_url"]
		if firstOK || lastOK {
			if _, exists := result["images"]; exists {
				return nil, fmt.Errorf("frame controls conflict with reference images")
			}
			if !firstOK {
				return nil, fmt.Errorf("the documented frame array requires a first frame")
			}
			refs := []any{first}
			if lastOK {
				refs = append(refs, last)
			}
			result["images"] = refs
			result["first_last_frame"] = true
			delete(result, "start_image_url")
			delete(result, "end_image_url")
		}
	}
	for field, parameter := range parameters {
		aliases := []string{}
		meta, _ := parameter.Definition["x-channel-parameter"].(map[string]any)
		vendorFields, _ := meta["vendorFields"].([]any)
		for _, raw := range vendorFields {
			if name, ok := raw.(string); ok && !strings.ContainsAny(name, ".[]") && name != field {
				aliases = append(aliases, name)
			}
		}
		if field == "seconds" {
			aliases = append(aliases, "duration", "duration_seconds")
		}
		if field == "aspect_ratio" {
			aliases = append(aliases, "ratio", "aspectRatio")
		}
		if field == "image" || field == "start_image_url" {
			aliases = append(aliases, "first_frame")
			if field == "image" {
				aliases = append(aliases, "start_image_url")
			}
		}
		if field == "last_frame" {
			aliases = append(aliases, "end_image_url")
		}
		if field == "end_image_url" {
			aliases = append(aliases, "last_frame")
		}
		for _, alias := range aliases {
			value, present := result[alias]
			if !present {
				continue
			}
			if field == "images" || field == "videos" || field == "audios" {
				if _, ok := value.([]any); !ok {
					value = []any{value}
				}
			}
			if alias == "extra_images" {
				prior, _ := result[field].([]any)
				result[field] = append(prior, value.([]any)...)
				delete(result, alias)
				continue
			}
			if prior, ok := result[field]; ok && !reflect.DeepEqual(prior, value) && !(field == "seconds" && fmt.Sprint(prior) == fmt.Sprint(value)) {
				return nil, fmt.Errorf("conflicting documented aliases for %s", field)
			}
			result[field] = value
			delete(result, alias)
		}
	}
	return result, nil
}

// InterfaceContract projects documentation for an actual model, without ever
// adding that model to discovery, routing, billing or an enabled channel.
func InterfaceContract(provider, id, model string) (map[string]any, error) {
	raw, err := ProviderCatalog(provider)
	if err != nil {
		return nil, err
	}
	interfaces, _ := raw.(map[string]any)["interfaces"].(map[string]any)
	entry, ok := interfaces[id].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("documented parameter interface not found")
	}
	rules, _ := entry["modelRules"].(map[string]any)
	if specific, ok := rules[model].(map[string]any); ok {
		return specific, nil
	}
	return entry, nil
}

func validateInterfaceParameters(document Document) error {
	for model, bindings := range document.Bindings {
		for key, binding := range bindings {
			mode := document.Groups[binding.GroupID].Modes[key]
			protocol := mode.Protocol
			if binding.Protocol != nil {
				protocol = binding.Protocol
			}
			for _, parameter := range mergeParameters(mode.Parameters, binding.Parameters) {
				if UnrestrictedValueLimits(parameter) && (protocol == nil || !strings.HasPrefix(protocol.TemplateModel, "interface:")) {
					return fmt.Errorf("%s/%s: choose a documented interface before using unrestricted values", model, key)
				}
			}
			if protocol == nil || !strings.HasPrefix(protocol.TemplateModel, "interface:") || !mode.Enabled || binding.Enabled != nil && !*binding.Enabled {
				continue
			}
			contract, err := InterfaceContract(document.Provider, protocol.TemplateModel, model)
			if err != nil {
				return err
			}
			contract, err = SupplementInterface(contract, protocol)
			if err != nil {
				return err
			}
			modes, _ := contract["modes"].(map[string]any)
			if _, ok := modes[key]; !ok {
				return fmt.Errorf("%s: mode is absent from its documented model constraints", model)
			}
			rules, _ := contract["parameters"].(map[string]any)
			parameters := mergeParameters(mode.Parameters, binding.Parameters)
			mapping := map[string]string{}
			for field, target := range mode.Mapping {
				mapping[field] = target
			}
			for field, target := range binding.Mapping {
				mapping[field] = target
			}
			for field, raw := range rules {
				var expected Parameter
				data, _ := common.Marshal(raw)
				if err := common.Unmarshal(data, &expected); err != nil {
					return err
				}
				meta, _ := expected.Definition["x-channel-parameter"].(map[string]any)
				caps, _ := meta["capabilities"].([]any)
				required := expected.Required != nil && *expected.Required
				requiredIn, _ := meta["requiredIn"].([]any)
				for _, mode := range requiredIn {
					if mode == key {
						required = true
					}
				}
				if !required {
					if !slices.Contains(caps, any("base")) && !slices.Contains(caps, any(key)) {
						continue
					}
				}
				actual, exists := parameters[field]
				if required && (!exists || actual.Required == nil || !*actual.Required || strings.HasPrefix(mapping[field], "@")) {
					return fmt.Errorf("%s/%s/%s: required document rules must be retained", model, key, field)
				}
				if !exists {
					continue
				}
				if actual.Definition["x-business-allowed-values"] == "unlimited" && required {
					return fmt.Errorf("%s/%s/%s: required document rules must be retained", model, key, field)
				}
				if UnrestrictedValueLimits(actual) {
					expected = withoutValueLimits(expected)
				}
				for _, candidate := range actual.Enum {
					if err := validateParameter(field, candidate, expected); err != nil {
						return fmt.Errorf("%s/%s: candidate exceeds documentation: %w", model, key, err)
					}
				}
				if expected.Minimum != nil && actual.Minimum != nil && *actual.Minimum < *expected.Minimum || expected.Maximum != nil && actual.Maximum != nil && *actual.Maximum > *expected.Maximum {
					return fmt.Errorf("%s/%s/%s: bounds exceed documentation", model, key, field)
				}
				if len(actual.Default) > 0 {
					var value any
					if err := common.Unmarshal(actual.Default, &value); err != nil {
						return err
					}
					if err := validateParameter(field, value, expected); err != nil {
						return err
					}
				}
			}
			for field := range parameters {
				if _, ok := rules[field]; !ok && mapping[field] != "@ignore" && mapping[field] != "@reject" {
					return fmt.Errorf("%s/%s/%s: field is absent from documentation", model, key, field)
				}
			}
		}
	}
	return nil
}
