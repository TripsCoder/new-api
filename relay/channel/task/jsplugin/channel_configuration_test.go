package jsplugin

import (
	"github.com/QuantumNous/new-api/common"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func configurationFixture(revision int64, n float64) *modelconfig.Document {
	d := modelconfig.Empty("paisio_media")
	d.Revision = revision
	d.Groups["g"] = modelconfig.Group{Name: "group", Modes: map[string]modelconfig.Mode{"text_image": {Enabled: true, Input: map[string]any{"n": n}}}}
	d.Bindings["mock-v1"] = map[string]modelconfig.Binding{"text_image": {GroupID: "g"}}
	return &d
}
func TestChannelConfigurationPreservesRetryAndPartialModels(t *testing.T) {
	plugin, err := pluginruntime.NewRegistry().Register(strings.Replace(mockPlugin, "mock-task", "paisio_media", 1), pluginruntime.Options{})
	require.NoError(t, err)
	a := New(plugin)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/images/generations", nil)
	original := map[string]any{"operation": "image_generate", "input": map[string]any{"prompt": "hello", "async": false}}
	c.Set("task_request", original)
	pin := &requestConfigurationPin{Original: original, Documents: map[int]*modelconfig.Document{11: configurationFixture(1, 2), 12: configurationFixture(8, 5), 13: nil}}
	c.Set(channelConfigurationPinKey, pin)
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 11}, OriginModelName: "mock-v1"}
	require.NoError(t, restoreChannelConfigurationInput(c))
	require.NoError(t, a.applyChannelModelConfiguration(c, info))
	require.Equal(t, float64(2), c.MustGet("task_request").(map[string]any)["input"].(map[string]any)["n"])
	require.Equal(t, int64(1), c.GetInt64("channel_model_configuration_revision"))
	info.ChannelId = 12
	require.NoError(t, restoreChannelConfigurationInput(c))
	require.NoError(t, a.applyChannelModelConfiguration(c, info))
	require.Equal(t, float64(5), c.MustGet("task_request").(map[string]any)["input"].(map[string]any)["n"])
	info.ChannelId = 13
	require.NoError(t, restoreChannelConfigurationInput(c))
	require.NoError(t, a.applyChannelModelConfiguration(c, info))
	require.NotContains(t, c.MustGet("task_request").(map[string]any)["input"], "n")
	info.ChannelId = 11
	info.OriginModelName = "unconfigured"
	require.NoError(t, restoreChannelConfigurationInput(c))
	require.NoError(t, a.applyChannelModelConfiguration(c, info))
	require.NotContains(t, c.MustGet("task_request").(map[string]any)["input"], "n")
	require.NotContains(t, original["input"], "n")
}
func TestChannelConfigurationRejectsOrderedOverrideOnlyWhenBound(t *testing.T) {
	source := strings.Replace(mockPlugin, "mock-task", "paisio_media", 1)
	plugin, err := pluginruntime.NewRegistry().Register(source, pluginruntime.Options{})
	require.NoError(t, err)
	plugin.Meta.RequiredCapabilities = []string{pluginruntime.CapabilityJSONOrder}
	a := New(plugin)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/images/generations", nil)
	original := map[string]any{"operation": "image_generate", "input": map[string]any{"prompt": "hello"}}
	c.Set("task_request", original)
	c.Set(channelConfigurationPinKey, &requestConfigurationPin{Original: original, Documents: map[int]*modelconfig.Document{11: configurationFixture(1, 2)}})
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 11}, OriginModelName: "mock-v1"}
	require.ErrorContains(t, a.applyChannelModelConfiguration(c, info), "JSON-order")
	info.OriginModelName = "other"
	require.NoError(t, restoreChannelConfigurationInput(c))
	require.NoError(t, a.applyChannelModelConfiguration(c, info))
}

func TestChannelConfigurationDoesNotOverwriteAnotherPluginDecoder(t *testing.T) {
	plugin, err := pluginruntime.NewRegistry().Register(strings.Replace(mockPlugin, "mock-task", "paisio_media", 1), pluginruntime.Options{})
	require.NoError(t, err)
	a := New(plugin)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/images/generations", nil)
	original := map[string]any{"operation": "image_generate", "input": map[string]any{"prompt": "hello"}}
	c.Set("task_request", original)
	c.Set(channelConfigurationPinKey, &requestConfigurationPin{Original: original, Documents: map[int]*modelconfig.Document{11: configurationFixture(1, 2)}})
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 11}, OriginModelName: "mock-v1"}
	require.NoError(t, a.applyChannelModelConfiguration(c, info))
	require.NoError(t, restoreChannelConfigurationInput(c))
	// This is what the next final decoder produces after the previous overlay is undone.
	decoded := map[string]any{"provider_specific": true, "prompt": "next"}
	c.Set("task_request", decoded)
	other, err := pluginruntime.NewRegistry().Register(mockPlugin, pluginruntime.Options{})
	require.NoError(t, err)
	require.NoError(t, New(other).applyChannelModelConfiguration(c, info))
	require.Equal(t, decoded, c.MustGet("task_request"))
}

func TestChannelConfigurationRunsBeforeRealProviderValidation(t *testing.T) {
	raw, err := os.ReadFile("../../../../plugin-sources/media-providers/profiles.json")
	require.NoError(t, err)
	var profiles map[string]map[string]any
	require.NoError(t, common.Unmarshal(raw, &profiles))
	provider := profiles["paisio_media"]
	var selected string
	models := provider["models"].(map[string]any)
	for name, value := range models {
		if value.(map[string]any)["kind"] == "image" {
			selected = name
			break
		}
	}
	require.NotEmpty(t, selected)
	provider["models"] = map[string]any{selected: models[selected]}
	providerJSON, err := common.Marshal(provider)
	require.NoError(t, err)
	runtime, err := os.ReadFile("../../../../plugin-sources/media-providers/runtime.js")
	require.NoError(t, err)
	metaJSON, err := common.Marshal(map[string]any{"apiVersion": 1, "key": "paisio_media", "name": "Real source fixture", "version": "2.0.0", "author": map[string]any{"name": "test"}, "models": []string{selected}, "fetchMode": "per_task", "protocols": []any{map[string]any{"name": "openai_image", "models": []string{selected}}}})
	require.NoError(t, err)
	source := "const PROVIDER = " + string(providerJSON) + "; export const meta = " + string(metaJSON) + ";\n" + string(runtime)
	plugin, err := pluginruntime.NewRegistry().Register(source, pluginruntime.Options{})
	require.NoError(t, err)
	decoded, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_image", "decodeRequest"}, map[string]any{"model": selected, "operation": "generate", "body": map[string]any{"kind": "json", "value": map[string]any{"model": selected, "custom_prompt": "mapped fixture"}}})
	require.NoError(t, err)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/images/generations", nil)
	c.Set("task_request", decoded.(map[string]any)["requestBody"])
	document := configurationFixture(1, 1)
	delete(document.Bindings, "mock-v1")
	document.Bindings[selected] = map[string]modelconfig.Binding{"text_image": {GroupID: "g"}}
	group := document.Groups["g"]
	mode := group.Modes["text_image"]
	mode.Mapping = map[string]string{"custom_prompt": "prompt"}
	group.Modes["text_image"] = mode
	document.Groups["g"] = group
	original, err := copyNormalizedRequest(c.MustGet("task_request"))
	require.NoError(t, err)
	c.Set(channelConfigurationPinKey, &requestConfigurationPin{Original: original, Documents: map[int]*modelconfig.Document{11: document}})
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 11, ChannelBaseUrl: "https://provider.invalid", ApiKey: "isolated-placeholder", UpstreamModelName: selected}, OriginModelName: selected, TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_configuration_fixture_0001"}}
	adaptor := New(plugin)
	adaptor.Init(info)
	require.NoError(t, adaptor.applyChannelModelConfiguration(c, info))
	descriptor, err := adaptor.buildSubmit(c, info)
	require.NoError(t, err)
	body, err := copyNormalizedRequest(descriptor.Body)
	require.NoError(t, err)
	require.Equal(t, "mapped fixture", body["prompt"])
	require.NotContains(t, body, "custom_prompt")
}

func TestChannelConfigurationNoOverlayLeavesPrivateBodyUntouched(t *testing.T) {
	plugin, err := pluginruntime.NewRegistry().Register(strings.Replace(mockPlugin, "mock-task", "paisio_media", 1), pluginruntime.Options{})
	require.NoError(t, err)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/videos", nil)
	body := []any{"opaque-original"}
	c.Set("task_request", body)
	c.Set(channelConfigurationPinKey, &requestConfigurationPin{Documents: map[int]*modelconfig.Document{11: nil}})
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 11}}
	require.NoError(t, New(plugin).applyChannelModelConfiguration(c, info))
	require.Equal(t, body, c.MustGet("task_request"))
}

func TestChannelConfigurationReferenceModesCannotBypassDisable(t *testing.T) {
	plugin, err := pluginruntime.NewRegistry().Register(strings.Replace(mockPlugin, "mock-task", "paisio_media", 1), pluginruntime.Options{})
	require.NoError(t, err)
	doc := modelconfig.Empty("paisio_media")
	doc.Groups["g"] = modelconfig.Group{Name: "G", Modes: map[string]modelconfig.Mode{"text_video": {Enabled: true, Input: map[string]any{}}, "image_video": {Enabled: false, Input: map[string]any{}, Mapping: map[string]string{"custom_refs": "images"}}}}
	doc.Bindings["mock-v1"] = map[string]modelconfig.Binding{"text_video": {GroupID: "g"}, "image_video": {GroupID: "g"}}
	cases := []map[string]any{{"input": map[string]any{"input_reference": "https://example.com/ref.png"}}, {"input": map[string]any{"image[]": []any{"https://example.com/ref.png"}}}, {"input": map[string]any{}, "uploads": []any{map[string]any{"field": "input_reference", "mimeType": "image/png"}}}, {"input": map[string]any{"custom_refs": []any{"https://example.com/ref.png"}}}}
	for _, body := range cases {
		body["operation"] = "video_generate"
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/v1/videos", nil)
		c.Set("task_request", body)
		c.Set(channelConfigurationPinKey, &requestConfigurationPin{Documents: map[int]*modelconfig.Document{11: &doc}})
		info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 11}, OriginModelName: "mock-v1"}
		require.ErrorContains(t, New(plugin).applyChannelModelConfiguration(c, info), "disabled")
	}
	group := doc.Groups["g"]
	mode := group.Modes["text_video"]
	mode.Input = map[string]any{"images": []any{"https://example.com/default.png"}}
	group.Modes["text_video"] = mode
	doc.Groups["g"] = group
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/videos", nil)
	c.Set("task_request", map[string]any{"operation": "video_generate", "input": map[string]any{"prompt": "hello"}})
	c.Set(channelConfigurationPinKey, &requestConfigurationPin{Documents: map[int]*modelconfig.Document{11: &doc}})
	require.ErrorContains(t, New(plugin).applyChannelModelConfiguration(c, &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 11}, OriginModelName: "mock-v1"}), "changes the generation mode")
}

func TestManualProtocolBindingStagingPreservesLegacyCalls(t *testing.T) {
	plugin, err := pluginruntime.NewRegistry().Register(strings.Replace(mockPlugin, "mock-task", "paisio_media", 1), pluginruntime.Options{})
	require.NoError(t, err)
	d := configurationFixture(3, 99)
	g := d.Groups["g"]
	m := g.Modes["text_image"]
	m.Protocol = &modelconfig.ProtocolBinding{TemplateModel: "not-activated-yet", Confirmed: true}
	m.Enabled = false
	g.Modes["text_image"] = m
	d.Groups["g"] = g
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/images/generations", nil)
	original := map[string]any{"operation": "image_generate", "input": map[string]any{"prompt": "legacy", "n": float64(1)}}
	c.Set("task_request", original)
	c.Set(channelConfigurationPinKey, &requestConfigurationPin{Documents: map[int]*modelconfig.Document{11: d}})
	require.NoError(t, New(plugin).applyChannelModelConfiguration(c, &relaycommon.RelayInfo{OriginModelName: "mock-v1", ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 11}}))
	require.Equal(t, original, c.MustGet("task_request"))
	require.Zero(t, c.GetInt64(modelconfig.ContextKeyRevision))
}

func TestChannelConfigurationUnrestrictedFieldsAreOnlyFromSavedState(t *testing.T) {
	plugin, err := pluginruntime.NewRegistry().Register(strings.Replace(mockPlugin, "mock-task", "paisio_media", 1), pluginruntime.Options{})
	require.NoError(t, err)
	a := New(plugin)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/images/generations", nil)
	original := map[string]any{"operation": "image_generate", "input": map[string]any{"prompt": "hello"}, "unrestrictedValueFields": []string{"prompt"}}
	d := configurationFixture(1, 2)
	m := d.Groups["g"].Modes["text_image"]
	m.Parameters = map[string]modelconfig.Parameter{"n": {Definition: map[string]any{"x-business-allowed-values": "unlimited"}}}
	d.Groups["g"] = modelconfig.Group{Name: "shared", Modes: map[string]modelconfig.Mode{"text_image": m}}
	c.Set("task_request", original)
	c.Set(channelConfigurationPinKey, &requestConfigurationPin{Original: original, Documents: map[int]*modelconfig.Document{11: d}})
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 11}, OriginModelName: "mock-v1"}
	require.NoError(t, a.applyChannelModelConfiguration(c, info))
	require.Equal(t, []string{"n"}, c.MustGet("task_request").(map[string]any)["unrestrictedValueFields"])
	require.Equal(t, []string{"prompt"}, original["unrestrictedValueFields"])
}
