package jsplugin

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestYuxiboxNewDocumentContractsRunInHostEngine(t *testing.T) {
	source, err := os.ReadFile("../../plugin-sources/media-providers/six-v2/dist/yuxibox_media.plugin.js")
	require.NoError(t, err)
	engine, err := Compile(string(source), Options{Key: "yuxibox_media", Version: "2.1.4"})
	require.NoError(t, err)
	for _, model := range []string{"seedance-2.0（YX）", "seedance-2.5（YX）", "seedance-2.5（YX）-按次", "seedance2.5-yx-count"} {
		ctx := map[string]any{"model": model, "upstreamModel": model, "baseUrl": "https://provider.invalid", "apiKey": "offline-fixture", "requestBody": map[string]any{"protocolTemplate": "interface:cd545ac5f694b3b2", "operation": "video_generate", "input": map[string]any{"prompt": "Fixture", "videos": []any{"https://media.example/ref.mp4"}, "audios": []any{"https://media.example/ref.wav"}}}}
		result, err := engine.Call(context.Background(), "buildSubmitRequest", ctx)
		require.NoError(t, err, model)
		body := result.(map[string]any)["body"].(map[string]any)
		require.Equal(t, model, body["model"])
		require.Contains(t, body, "videos")
		require.Contains(t, body, "audios")
		require.NotContains(t, body, "seconds")
	}
}
