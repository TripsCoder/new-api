package plugins

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/stretchr/testify/require"
	"os"
	"path/filepath"
	"testing"
)

func TestSixProviderFinalArtifactsRetainLegacySavedConfiguration(t *testing.T) {
	root := filepath.Join("..", "plugin-sources", "media-providers", "six-v2")
	raw, err := os.ReadFile(filepath.Join(root, "evidence", "legacy-initial-configurations-2.0.2.json"))
	require.NoError(t, err)
	var drafts struct {
		Configurations map[string]modelconfig.Document `json:"configurations"`
	}
	require.NoError(t, common.Unmarshal(raw, &drafts))
	raw, err = os.ReadFile(filepath.Join(root, "profiles.json"))
	require.NoError(t, err)
	var providers map[string]struct {
		Models map[string]map[string]any `json:"models"`
	}
	require.NoError(t, common.Unmarshal(raw, &providers))
	require.Len(t, providers, 6)
	count := 0
	for key, provider := range providers {
		document := drafts.Configurations[key]
		require.NoError(t, modelconfig.Validate(document), key)
		source, err := os.ReadFile(filepath.Join(root, "dist", key+".plugin.js"))
		require.NoError(t, err)
		plugin, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{Key: key})
		require.NoError(t, err)
		for name, p := range provider.Models {
			t.Run(key+"/"+name, func(t *testing.T) {
				protocol, operation := "openai_video", "create"
				if p["kind"] == "image" {
					protocol = "openai_image"
					operation = "generate"
				}
				input := map[string]any{"model": name, "prompt": "Isolated final artifact fixture"}
				if p["secondsField"] != nil || p["fixedSeconds"] != nil {
					seconds := p["defaultSeconds"]
					if seconds == nil {
						if choices, ok := p["secondsChoices"].([]any); ok && len(choices) > 0 {
							seconds = choices[0]
						}
					}
					if seconds == nil {
						seconds = p["minSeconds"]
					}
					input["seconds"] = seconds
				}
				minimum, _ := p["minImages"].(float64)
				if p["firstLastOnly"] == true && minimum < 1 {
					minimum = 1
				}
				if minimum > 0 {
					refs := make([]any, int(minimum))
					for i := range refs {
						refs[i] = "https://media.example.com/reference.png"
					}
					input["images"] = refs
				}
				if minimumAudio, ok := p["minAudios"].(float64); ok && minimumAudio > 0 {
					refs := make([]any, int(minimumAudio))
					for i := range refs {
						refs[i] = "https://media.example.com/reference.mp3"
					}
					input["audios"] = refs
				}
				if p["anyImageOrAudio"] == true && input["images"] == nil && input["audios"] == nil {
					input["images"] = []any{"https://media.example.com/reference.png"}
				}
				decoded, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{protocol, "decodeRequest"}, map[string]any{"model": name, "upstreamModel": name, "operation": operation, "body": map[string]any{"kind": "json", "value": input}})
				require.NoError(t, err)
				wrapper := decoded.(map[string]any)
				body := wrapper["requestBody"].(map[string]any)
				original := body["input"].(map[string]any)
				action := body["operation"].(string)
				hint, _ := body["contractMode"].(string)
				mode, err := modelconfig.InferConfiguredMode(document, name, action, original, body["uploads"], hint)
				require.NoError(t, err)
				require.Contains(t, document.Bindings[name], mode)
				effective, _, err := modelconfig.Resolve(document, name, mode, original)
				require.NoError(t, err)
				require.Equal(t, mode, modelconfig.InferContractMode(action, effective, body["uploads"], hint))
				body["input"] = effective
				var descriptor map[string]any
				require.NoError(t, plugin.Engine.CallInto(t.Context(), &descriptor, "buildSubmitRequest", map[string]any{"model": name, "upstreamModel": name, "baseUrl": "https://provider.invalid", "apiKey": "isolated-test-only", "publicTaskId": "task_final_artifact_configuration_0001", "requestBody": body, "files": []any{}}))
				require.NotEmpty(t, descriptor["url"])
				count++
			})
		}
	}
	require.Equal(t, 220, count)
}

func TestZexCompatibilityNamesUseExistingCanonicalRoutingWithoutMetadataCollisions(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", "zhangyuge_media.plugin.js"))
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.Register(string(source), jsplugin.Options{Key: "zhangyuge_media"})
	require.NoError(t, err)
	require.Len(t, plugin.Meta.Models, 45)
	for alias, target := range map[string]string{"MiniMax-H3": "minimax-h3", "gpt-image-2-2k": "gpt-image-2-2K", "gpt-image-2-4k": "gpt-image-2-4K"} {
		canonical, ok := registry.Generation().CanonicalModel(alias)
		require.True(t, ok)
		require.Equal(t, target, canonical)
		require.Equal(t, target, modelconfig.CanonicalReviewedModelName("zhangyuge_media", alias))
		schema, _ := plugin.Meta.UsageForModels(alias)
		require.NotEmpty(t, schema)
	}
}
