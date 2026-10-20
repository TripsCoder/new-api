package modelconfig

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestManualProtocolBindingValidationAndDiscoveryIndependence(t *testing.T) {
	d := Empty("paisio_media")
	raw, err := ProviderCatalog(d.Provider)
	require.NoError(t, err)
	models := raw.(map[string]any)["models"].(map[string]any)
	template := ""
	for name, raw := range models {
		item := raw.(map[string]any)
		modes, _ := item["modes"].(map[string]any)
		if _, ok := modes["text_image"]; ok {
			template = name
			break
		}
	}
	require.NotEmpty(t, template)
	protocol := &ProtocolBinding{TemplateModel: template}
	d.Groups["g"] = Group{Name: "manual", Modes: map[string]Mode{"text_image": {Enabled: true, Input: map[string]any{}, Protocol: protocol}}}
	d.Bindings["future-not-in-models-response"] = map[string]Binding{"text_image": {GroupID: "g"}}
	require.ErrorContains(t, Validate(d), "confirm")
	protocol.Confirmed = true
	require.NoError(t, Validate(d))
	require.NotNil(t, ManualProtocolFor(d, "future-not-in-models-response", "text_image"))
	// There is no discovery prerequisite, cache or mutation in configuration.
	_, definition, err := Resolve(d, "future-not-in-models-response", "text_image", map[string]any{"prompt": "test"})
	require.NoError(t, err)
	require.Equal(t, template, definition.Protocol.TemplateModel)
	require.Error(t, ValidateProtocolBinding(d.Provider, "text_video", protocol))
	require.Error(t, ValidateProtocolBinding(d.Provider, "text_image", &ProtocolBinding{TemplateModel: "https://other.invalid", Confirmed: true}))
	for _, status := range []string{"", "unknown", "available"} {
		require.False(t, XCMExplicitlyUnavailable(status))
	}
	for _, status := range []string{"preparing", "maintenance", "unavailable"} {
		require.True(t, XCMExplicitlyUnavailable(status))
	}
}
