package modelconfig

import "errors"

func SupportedProvider(key string) bool {
	switch key {
	case "paisio_media", "yuxibox_media", "xcmapi_media", "artbox_media", "lxmone_media", "zhangyuge_media":
		return true
	}
	return false
}

// InferMode uses the existing normalized operation and provided references,
// never a model-name heuristic or a new public request field.
func InferMode(operation string, input map[string]any, uploads ...any) string {
	if operation == "image_edit" {
		return "edit_image"
	}
	if operation == "image_generate" {
		return "text_image"
	}
	present := func(keys ...string) bool {
		for _, key := range keys {
			v, ok := input[key]
			if !ok || v == nil {
				continue
			}
			switch x := v.(type) {
			case string:
				if x != "" {
					return true
				}
			case []any:
				if len(x) > 0 {
					return true
				}
			case bool:
				if x {
					return true
				}
			default:
				return true
			}
		}
		return false
	}
	referenceKinds := map[string]bool{}
	frames := false
	for _, key := range []string{"images", "image", "image[]", "input_reference", "image_urls", "reference_images", "reference_image_urls"} {
		values, _ := input[key].([]any)
		if single, ok := input[key].(map[string]any); ok {
			values = []any{single}
		}
		for _, raw := range values {
			if ref, ok := raw.(map[string]any); ok {
				if ref["type"] == "first_frame" || ref["type"] == "end_frame" || ref["role"] == "first_frame" || ref["role"] == "last_frame" {
					frames = true
				}
			}
		}
	}
	if materials, ok := input["materials"].([]any); ok {
		for _, raw := range materials {
			if item, ok := raw.(map[string]any); ok {
				kind, _ := item["type"].(string)
				referenceKinds[kind] = true
				if item["role"] == "first_frame" || item["role"] == "last_frame" {
					frames = true
				}
			}
		}
	}
	if frames || input["first_last_frame"] == true || input["first_last_frame"] == "true" || present("start_image_url", "end_image_url", "first_frame", "last_frame") {
		return "frames"
	}
	uploadKinds := referenceKinds
	for _, raw := range uploads {
		if files, ok := raw.([]any); ok {
			for _, rawFile := range files {
				if file, ok := rawFile.(map[string]any); ok {
					mime, _ := file["mimeType"].(string)
					if len(mime) > 6 {
						switch {
						case len(mime) >= 6 && mime[:6] == "image/":
							uploadKinds["image"] = true
						case mime[:6] == "video/":
							uploadKinds["video"] = true
						case mime[:6] == "audio/":
							uploadKinds["audio"] = true
						}
					}
				}
			}
		}
	}
	videos := uploadKinds["video"] || present("videos", "video_urls", "extra_videos", "reference_videos", "reference_video_urls")
	audios := uploadKinds["audio"] || present("audios", "audio_urls", "extra_audios", "reference_audios", "reference_audio_urls")
	if videos && audios {
		return "mixed_ref"
	}
	if videos {
		return "video_ref"
	}
	if audios {
		return "audio_ref"
	}
	if uploadKinds["image"] || present("input_reference", "image[]", "images", "image", "image_url", "image_urls", "extra_images", "reference_images", "reference_image_urls") {
		return "image_video"
	}
	return "text_video"
}

func SupportedMode(mode string) bool {
	switch mode {
	case "text_image", "edit_image", "text_video", "image_video", "frames", "video_ref", "audio_ref", "mixed_ref":
		return true
	}
	return false
}

// InferConfiguredMode recognizes explicit reference aliases before checking the
// enabled mode. Defaults may not silently turn one generation mode into another.
func InferConfiguredMode(document Document, model, operation string, input map[string]any, uploads any, contractMode ...string) (string, error) {
	original := InferContractMode(operation, input, uploads, contractMode...)
	chosen := ""
	for mode, binding := range document.Bindings[model] {
		definition, exists := document.Groups[binding.GroupID].Modes[mode]
		if !exists {
			continue
		}
		mapping := map[string]string{}
		for key, value := range definition.Mapping {
			if value != "@ignore" && value != "@reject" {
				mapping[key] = value
			}
		}
		for key, value := range binding.Mapping {
			delete(mapping, key)
			if value != "@ignore" && value != "@reject" {
				mapping[key] = value
			}
		}
		mapped, err := applyMapping(cloneMap(input), mapping)
		if err != nil {
			if mode == original {
				return "", err
			}
			continue
		}
		hints := contractMode
		protocol := definition.Protocol
		if binding.Protocol != nil {
			protocol = binding.Protocol
		}
		if hint := ProtocolContractHint(document.Provider, protocol); hint != "" {
			hints = []string{hint}
		}
		actual := InferContractMode(operation, mapped, uploads, hints...)
		if actual != original && actual == mode {
			if chosen != "" && chosen != actual {
				return "", errors.New("parameter mappings select conflicting generation modes")
			}
			chosen = actual
		}
	}
	if chosen != "" {
		return chosen, nil
	}
	return original, nil
}

// InferContractMode accepts only a private decoder hint from the pinned plugin.
// Frame-only contracts still require references; a public input field cannot
// force a text request into an enabled frame mode.
func InferContractMode(operation string, input map[string]any, uploads any, hints ...string) string {
	mode := InferMode(operation, input, uploads)
	if mode == "image_video" && len(hints) > 0 && hints[0] == "frames" {
		return "frames"
	}
	return mode
}
