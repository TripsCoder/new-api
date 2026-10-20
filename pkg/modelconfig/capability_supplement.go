package modelconfig

import (
	"errors"
	"github.com/QuantumNous/new-api/common"
	"maps"
	"strings"
)

// SupplementInterface adds only missing reference fields to a compiled interface.
// This is administrator configuration, never a request-supplied schema or script.
func SupplementInterface(contract map[string]any, binding *ProtocolBinding) (map[string]any, error) {
	if binding == nil || len(binding.Supplement) == 0 {
		return contract, nil
	}
	if len(binding.Supplement) > 6 {
		return nil, errors.New("too many capability supplements")
	}
	raw, err := common.Marshal(contract)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err = common.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	rules, _ := result["parameters"].(map[string]any)
	modes, _ := result["modes"].(map[string]any)
	if rules == nil || modes == nil {
		return nil, errors.New("supplement requires a documented interface")
	}
	vendors := map[string]bool{}
	for _, raw := range rules {
		p, _ := raw.(map[string]any)
		def, _ := p["definition"].(map[string]any)
		meta, _ := def["x-channel-parameter"].(map[string]any)
		names, _ := meta["vendorFields"].([]any)
		for _, name := range names {
			s, _ := name.(string)
			vendors[s] = true
		}
	}
	allowed := map[string][]string{"image_video": {"images"}, "edit_image": {"images"}, "video_ref": {"videos"}, "audio_ref": {"audios"}, "frames": {"start_image_url", "end_image_url"}}
	for mode, supplement := range binding.Supplement {
		fields, ok := allowed[mode]
		if !ok || strings.TrimSpace(supplement.Note) == "" || len(supplement.Note) > 1000 || len(supplement.Fields) == 0 || len(supplement.Fields) > 2 {
			return nil, errors.New("invalid manual capability supplement")
		}
		for field, entry := range supplement.Fields {
			if entry.Shape == "url" && entry.MaxItems > 1 {
				return nil, errors.New("single URL supplement cannot accept multiple references")
			}
			valid := false
			for _, name := range fields {
				if name == field {
					valid = true
				}
			}
			if !valid || !namePattern.MatchString(entry.Vendor) || blocked.MatchString(entry.Vendor) || strings.ContainsAny(entry.Vendor, ".:") || vendors[entry.Vendor] || rules[field] != nil || entry.MaxItems < 0 || entry.MaxItems > 100 {
				return nil, errors.New("manual supplement must add a missing reference field without replacing document fields")
			}
			schema := map[string]any{"type": "array", "items": map[string]any{"type": "string"}}
			switch entry.Shape {
			case "urls":
			case "objects":
				schema["items"] = map[string]any{"type": "object", "properties": map[string]any{"url": map[string]any{"type": "string"}}, "required": []string{"url"}}
			case "url":
				schema["maxItems"] = 1
			default:
				return nil, errors.New("invalid manual reference format")
			}
			if field == "start_image_url" || field == "end_image_url" {
				if entry.Shape != "url" {
					return nil, errors.New("frame supplement requires one URL")
				}
				schema = map[string]any{"type": "string"}
			} else if entry.MaxItems > 0 {
				schema["maxItems"] = entry.MaxItems
			}
			definition := maps.Clone(schema)
			definition["x-channel-parameter"] = map[string]any{"vendorFields": []string{entry.Vendor}, "capabilities": []string{mode}, "requiredIn": []string{}, "status": "manual-supplement"}
			rules[field] = map[string]any{"type": schema["type"], "required": false, "definition": definition, "description": supplement.Note}
			vendors[entry.Vendor] = true
		}
		modes[mode] = map[string]any{"required": []string{}}
	}
	return result, nil
}

// ManualInterfaceFields is supplied by the host only after saved configuration
// resolution. The plugin adds these fields to its existing compiled wire codec.
func ManualInterfaceFields(binding *ProtocolBinding) map[string]any {
	if binding == nil {
		return nil
	}
	result := map[string]any{}
	for _, supplement := range binding.Supplement {
		for field, entry := range supplement.Fields {
			result[entry.Vendor] = map[string]any{"field": field, "shape": entry.Shape, "maxItems": entry.MaxItems}
		}
	}
	return result
}
