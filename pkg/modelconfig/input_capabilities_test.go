package modelconfig

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestIndependentCapabilitiesRejectDisabledAliasesDefaultsAndNestedMaterials(t *testing.T) {
	cap := &InputCapabilities{Images: true, Videos: true, Audios: false, FirstFrame: true, LastFrame: false}
	for name, input := range map[string]map[string]any{
		"audio alias":      {"audio_urls": []any{"https://example.com/a.mp3"}},
		"mixed material":   {"materials": []any{map[string]any{"type": "audio", "url": "https://example.com/a.mp3"}}},
		"nested last role": {"images": []any{map[string]any{"role": "last_frame", "url": "https://example.com/a.png"}}},
		"last flag":        {"first_last_frame": true},
	} {
		t.Run(name, func(t *testing.T) { require.Error(t, validateInputCapabilities(input, cap)) })
	}
	require.NoError(t, validateInputCapabilities(map[string]any{"prompt": "only prompt"}, cap))
	require.NoError(t, validateInputCapabilities(map[string]any{"videos": []any{"https://example.com/v.mp4"}}, cap))
	d := fixture()
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	m.Capabilities = cap
	m.Input["audios"] = []any{"https://example.com/default.mp3"}
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	_, _, err := Resolve(d, "a", "text_image", map[string]any{"prompt": "defaults must also obey capabilities"})
	require.ErrorContains(t, err, "audios")
}

func TestExplicitMappingPolicyIgnoresUnknownFieldsWithoutAffectingDocumentedSubsets(t *testing.T) {
	d := fixture()
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	m.StrictMapping = true
	m.Input = map[string]any{}
	m.Parameters = map[string]Parameter{"prompt": {Type: "string"}}
	m.Mapping = map[string]string{"client_note": "@ignore", "resolution": "@reject"}
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	result, _, err := Resolve(d, "a", "text_image", map[string]any{"prompt": "text only", "client_note": "discard explicitly"})
	require.NoError(t, err)
	require.Equal(t, map[string]any{"prompt": "text only"}, result)
	result, _, err = Resolve(d, "a", "text_image", map[string]any{"prompt": "text only", "unmapped_field": "must not pass"})
	require.NoError(t, err)
	require.Equal(t, map[string]any{"prompt": "text only"}, result)
}
