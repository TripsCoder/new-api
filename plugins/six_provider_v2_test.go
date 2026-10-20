package plugins

import (
	"context"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/stretchr/testify/require"
	"os"
	"path/filepath"
	"testing"
)

func TestSixProviderV2FinalSourcesCompileAndBuild(t *testing.T) {
	cases := []struct {
		key, model, operation string
		input                 map[string]any
	}{
		{"paisio_media", "gpt-image2-high", "image_generate", map[string]any{"n": 1, "async": false}},
		{"yuxibox_media", "seedance-2.0（官渠）", "video_generate", map[string]any{"seconds": 5}},
		{"xcmapi_media", "minimax-h3", "video_generate", map[string]any{"seconds": 5, "videos": []any{map[string]any{"url": "https://media.example.com/ref.mp4", "duration_seconds": 4}}}},
		{"artbox_media", "Artdance 2.5-720p", "video_generate", map[string]any{"seconds": 5}},
		{"lxmone_media", "seedance2.5-720s", "video_generate", map[string]any{"seconds": 5, "images": []any{"https://media.example.com/ref.png"}}},
		{"zhangyuge_media", "seedance-2.5-10s", "video_generate", map[string]any{"seconds": 10}},
	}
	for _, test := range cases {
		t.Run(test.key, func(t *testing.T) {
			source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", test.key+".plugin.js"))
			require.NoError(t, err)
			plugin, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{Key: test.key})
			require.NoError(t, err)
			require.Equal(t, "2.1.5", plugin.Meta.Version)
			require.NotEmpty(t, plugin.SourceSHA256)
			input := test.input
			input["prompt"] = "Isolated fixture"
			input["model"] = test.model
			ctx := map[string]any{"model": test.model, "upstreamModel": test.model, "baseUrl": "https://provider.invalid", "apiKey": "isolated-test-only", "publicTaskId": "task_six_provider_fixture_00001", "requestBody": map[string]any{"operation": test.operation, "input": input, "uploads": []any{}}, "files": []any{}}
			var descriptor map[string]any
			require.NoError(t, plugin.Engine.CallInto(context.Background(), &descriptor, "buildSubmitRequest", ctx))
			require.Contains(t, descriptor["url"], "https://provider.invalid/")
			raw, err := common.Marshal(descriptor)
			require.NoError(t, err)
			require.NotContains(t, string(raw), "/undefined")
		})
	}
}

// Individual compilation cannot detect global spelling conflicts with factory
// contracts. Exercise the actual factory/legacy/updated provider combination.
func TestSixProviderUpdatesCoexistWithFactoryAndLegacyProviders(t *testing.T) {
	registry := jsplugin.NewRegistry()
	entries, err := taskPlugins.ReadDir("tasks")
	require.NoError(t, err)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		source, err := Source(entry.Name())
		require.NoError(t, err)
		_, err = registry.RegisterFactory(source, jsplugin.Options{Key: entry.Name()})
		require.NoError(t, err)
	}
	oldKeys := []string{"paisio_media", "yuxibox_media", "xcmapi_media", "artbox_media", "lxmone_media", "zhangyuge_media", "cangyuan_media"}
	for _, key := range oldKeys {
		source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "dist", key+".plugin.js"))
		require.NoError(t, err)
		_, err = registry.Register(string(source), jsplugin.Options{Key: key})
		require.NoError(t, err)
	}
	untouched, ok := registry.Get("cangyuan_media")
	require.True(t, ok)
	untouchedHash := untouched.SourceSHA256
	for _, key := range []string{"paisio_media", "yuxibox_media", "lxmone_media", "zhangyuge_media", "xcmapi_media", "artbox_media"} {
		source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", key+".plugin.js"))
		require.NoError(t, err)
		_, err = registry.Register(string(source), jsplugin.Options{Key: key})
		require.NoError(t, err)
		published, ok := registry.Get(key)
		require.True(t, ok)
		require.Equal(t, "2.1.5", published.Meta.Version)
		require.Empty(t, registry.RoutingErrors())
	}
	untouched, ok = registry.Get("cangyuan_media")
	require.True(t, ok)
	require.Equal(t, untouchedHash, untouched.SourceSHA256)
	for _, key := range []string{"xcmapi_media", "zhangyuge_media"} {
		plugin, ok := registry.Get(key)
		require.True(t, ok)
		body := map[string]any{"operation": "video_generate", "input": map[string]any{"prompt": "fixture", "seconds": 5}}
		canonical, ok := plugin.Meta.CanonicalModel("MINIMAX-H3")
		require.True(t, ok)
		var descriptor map[string]any
		require.NoError(t, plugin.Engine.CallInto(context.Background(), &descriptor, "buildSubmitRequest", map[string]any{"model": canonical, "upstreamModel": canonical, "publicTaskId": "task_six_coexistence_fixture_00001", "baseUrl": "https://provider.invalid", "apiKey": "isolated", "requestBody": body}))
		require.Equal(t, "minimax-h3", descriptor["body"].(map[string]any)["model"])
	}
}
