package plugins

import (
	"context"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/stretchr/testify/require"
	"os"
	"path/filepath"
	"testing"
)

func TestPageConfigurationLegitimateSubsetsReachActualPluginContractWithoutNetwork(t *testing.T) {
	const key = "yuxibox_media"
	rawCatalog, err := modelconfig.ProviderCatalog(key)
	require.NoError(t, err)
	catalog := rawCatalog.(map[string]any)
	models := catalog["models"].(map[string]any)
	modelName := ""
	var entry map[string]any
	for name, raw := range models {
		m := raw.(map[string]any)
		// Use the variable-duration profile; map iteration can otherwise pick
		// its fixed-30-second sibling for a five-second request.
		if _, ok := m["modes"].(map[string]any)["mixed_ref"]; ok && name == "seedance2.5-yx-count" {
			modelName = name
			entry = m
			break
		}
	}
	require.NotEmpty(t, modelName)
	var parameters map[string]modelconfig.Parameter
	bytes, err := common.Marshal(entry["parameters"])
	require.NoError(t, err)
	require.NoError(t, common.Unmarshal(bytes, &parameters))
	for _, field := range []string{"images", "videos", "audios"} {
		require.Contains(t, parameters, field)
		require.NotNil(t, parameters[field].Definition["items"])
		require.True(t, parameters[field].Required == nil || !*parameters[field].Required)
	}
	var mapping map[string]string
	bytes, err = common.Marshal(entry["mapping"])
	require.NoError(t, err)
	require.NoError(t, common.Unmarshal(bytes, &mapping))
	// Mirror the formal form's explicit handling of unsupported common fields.
	for _, field := range []string{"prompt", "images", "videos", "audios", "aspect_ratio", "resolution", "seconds", "duration", "seed", "quality", "n"} {
		if _, ok := mapping[field]; !ok {
			if _, supported := parameters[field]; supported {
				mapping[field] = field
			} else {
				mapping[field] = "@reject"
			}
		}
	}
	document := modelconfig.Empty(key)
	document.Groups["page"] = modelconfig.Group{Name: "page accepted capability set", Modes: map[string]modelconfig.Mode{}}
	document.Bindings[modelName] = map[string]modelconfig.Binding{}
	for mode := range entry["modes"].(map[string]any) {
		document.Groups["page"].Modes[mode] = modelconfig.Mode{Enabled: true, Input: map[string]any{"seconds": float64(5)}, Parameters: parameters, Mapping: mapping, Cost: modelconfig.Cost{}}
		document.Bindings[modelName][mode] = modelconfig.Binding{GroupID: "page"}
	}
	source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", key+".plugin.js"))
	require.NoError(t, err)
	plugin, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{Key: key})
	require.NoError(t, err)
	cases := []struct {
		name       string
		references map[string]any
	}{
		{"prompt only", map[string]any{}},
		{"image", map[string]any{"images": []any{"https://media.example.com/reference.png"}}},
		{"video", map[string]any{"videos": []any{"https://media.example.com/reference.mp4"}}},
		{"audio", map[string]any{"audios": []any{"https://media.example.com/reference.mp3"}}},
		{"mixed", map[string]any{"images": []any{"https://media.example.com/reference.png"}, "videos": []any{"https://media.example.com/reference.mp4"}, "audios": []any{"https://media.example.com/reference.mp3"}}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			input := map[string]any{"prompt": "No network fixture"}
			for k, v := range test.references {
				input[k] = v
			}
			actual, err := modelconfig.InferConfiguredMode(document, modelName, "video_generate", input, nil)
			require.NoError(t, err)
			resolved, _, err := modelconfig.Resolve(document, modelName, actual, input)
			require.NoError(t, err)
			for _, field := range []string{"images", "videos", "audios"} {
				if _, present := input[field]; !present {
					require.NotContains(t, resolved, field)
				}
			}
			var descriptor map[string]any
			require.NoError(t, plugin.Engine.CallInto(context.Background(), &descriptor, "buildSubmitRequest", map[string]any{"model": modelName, "upstreamModel": modelName, "baseUrl": "https://fixture.invalid", "apiKey": "fixture-only", "publicTaskId": "task_page_configuration_contract_fixture_0001", "requestBody": map[string]any{"operation": "video_generate", "input": resolved, "uploads": []any{}}, "files": []any{}}))
			require.Equal(t, "POST", descriptor["method"])
			bytes, err := common.Marshal(descriptor)
			require.NoError(t, err)
			for _, raw := range test.references {
				for _, ref := range raw.([]any) {
					require.Contains(t, string(bytes), ref.(string))
				}
			}
		})
	}
}
