package modelconfig

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestYuxiboxVideoModelDocumentationIsComplete(t *testing.T) {
	raw, err := ProviderCatalog("yuxibox_media")
	require.NoError(t, err)
	interfaces := raw.(map[string]any)["interfaces"].(map[string]any)
	count := 0
	for id, raw := range interfaces {
		entry := raw.(map[string]any)
		if entry["kind"] != "video" {
			continue
		}
		for model := range entry["modelRules"].(map[string]any) {
			contract, err := InterfaceContract("yuxibox_media", id, model)
			require.NoError(t, err)
			parameters := contract["parameters"].(map[string]any)
			for _, field := range []string{"prompt", "seconds", "images", "audios"} {
				require.Contains(t, parameters, field, model)
			}
			images := parameters["images"].(map[string]any)
			definition := images["definition"].(map[string]any)
			require.Equal(t, "array", definition["type"], model)
			require.NotEmpty(t, definition["maxItems"], model)
			if model == "minimax-h3-fast" || model == "minimax-h3-quality" {
				require.Equal(t, false, images["required"])
				metadata := definition["x-channel-parameter"].(map[string]any)
				require.Contains(t, metadata["condition"], "OR")
				require.Contains(t, metadata["uploadAlternatives"], "input_reference")
			}
			if model == "wan3.0-video" || model == "wan3.0-video-prime" {
				for _, field := range []string{"videos", "audios"} {
					schema := parameters[field].(map[string]any)["definition"].(map[string]any)
					require.Equal(t, "array", schema["type"])
					require.Equal(t, float64(5), schema["maxItems"])
				}
			}
			count++
		}
	}
	require.Equal(t, 10, count)
}
