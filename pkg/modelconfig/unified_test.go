package modelconfig

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

func TestUpstreamOnlyDefaultsIgnoreCallerValues(t *testing.T) {
	for _, tc := range []struct {
		name    string
		value   any
		request map[string]any
	}{
		{"false", false, map[string]any{"generate_audio": true}},
		{"true", true, map[string]any{"generate_audio": false}},
		{"invalid caller value", false, map[string]any{"generate_audio": map[string]any{"bad": true}}},
		{"missing caller value", false, map[string]any{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := unifiedFixture()
			m := doc.Groups["g"].Modes["text_video"]
			var p Parameter
			require.NoError(t, common.UnmarshalJsonStr(`{"type":"boolean","inputPolicy":"upstream_default"}`, &p))
			m.Parameters["generate_audio"] = p
			m.Input = map[string]any{"generate_audio": tc.value}
			doc.Groups["g"].Modes["text_video"] = m
			request := cloneMap(tc.request)
			request["prompt"] = "fixture"
			original := cloneMap(request)
			got, _, _, _, err := ResolveUnified(doc, "dynamic-model", "video_generate", request, false)
			require.NoError(t, err)
			require.Equal(t, tc.value, got["generate_audio"])
			require.Equal(t, original, request)
		})
	}
}

func TestUpstreamOnlyDefaultsRequireExplicitValidScalar(t *testing.T) {
	for _, raw := range []string{
		`{"type":"boolean","inputPolicy":"upstream_default"}`,
		`{"type":"boolean","inputPolicy":"unknown"}`,
		`{"type":"boolean","required":true,"inputPolicy":"upstream_default"}`,
		`{"type":"array","inputPolicy":"upstream_default"}`,
	} {
		doc := unifiedFixture()
		m := doc.Groups["g"].Modes["text_video"]
		var p Parameter
		require.NoError(t, common.UnmarshalJsonStr(raw, &p))
		m.Parameters["generate_audio"] = p
		_, _, _, _, err := ResolveUnified(doc, "dynamic-model", "video_generate", map[string]any{"prompt": "fixture", "generate_audio": true}, false)
		require.Error(t, err, raw)
	}
}

func TestUpstreamOnlyDefaultsRemoveAliasesBeforeValidation(t *testing.T) {
	doc := unifiedFixture()
	m := doc.Groups["g"].Modes["text_video"]
	m.Input = map[string]any{"seconds": float64(6), "seed": float64(0)}
	m.Parameters["seconds"] = Parameter{Type: "integer", InputPolicy: InputPolicyUpstreamDefault}
	m.Parameters["seed"] = Parameter{Type: "integer", InputPolicy: InputPolicyUpstreamDefault}
	doc.Groups["g"].Modes["text_video"] = m
	for _, form := range []bool{false, true} {
		input, _, _, _, err := ResolveUnified(doc, "dynamic-model", "video_generate", map[string]any{"prompt": "fixture", "seconds": 9000, "duration": "bad", "duration_seconds": false, "seed": 12345}, form)
		require.NoError(t, err)
		require.Equal(t, float64(6), input["seconds"])
		require.Equal(t, float64(0), input["seed"])
		require.NotContains(t, input, "duration")
		require.NotContains(t, input, "duration_seconds")
	}
}

func unifiedFixture() Document {
	no := false
	return Document{Format: Format, Provider: "paisio_media", Revision: 10,
		Groups: map[string]Group{"g": {Modes: map[string]Mode{
			"text_video":  {Enabled: true, StrictMapping: true, Protocol: &ProtocolBinding{TemplateModel: "interface:fixture", Confirmed: true}, Parameters: map[string]Parameter{"prompt": {Type: "string", Required: boolPointer(true)}, "seconds": {Type: "integer", Default: json.RawMessage(`5`)}}, Capabilities: &InputCapabilities{}},
			"image_video": {Enabled: true, StrictMapping: true, Protocol: &ProtocolBinding{TemplateModel: "interface:fixture", Confirmed: true}, Parameters: map[string]Parameter{"images": {Type: "array", Required: &no, Definition: map[string]any{"maxItems": float64(9)}}}, Capabilities: &InputCapabilities{Images: true}},
			"video_ref":   {Enabled: true, StrictMapping: true, Protocol: &ProtocolBinding{TemplateModel: "interface:fixture", Confirmed: true}, Parameters: map[string]Parameter{"videos": {Type: "array"}}, Capabilities: &InputCapabilities{Videos: true}},
		}}}, Bindings: map[string]map[string]Binding{"dynamic-model": {"text_video": {GroupID: "g"}, "image_video": {GroupID: "g"}, "video_ref": {GroupID: "g"}}}}
}

func boolPointer(value bool) *bool { return &value }

func TestUnifiedOptionalFilteringPrecedesValidationAndPreservesPolicies(t *testing.T) {
	doc := unifiedFixture()
	g := doc.Groups["g"]
	m := g.Modes["text_video"]
	m.StrictMapping = false // Interface configuration filters even old permissive documents.
	m.Parameters["seconds"] = Parameter{Type: "integer", Enum: []any{float64(10)}}
	m.Parameters["seed"] = Parameter{Type: "integer"}
	m.Parameters["watermark"] = Parameter{Type: "boolean"}
	m.Parameters["generate_audio"] = Parameter{Type: "boolean", Default: json.RawMessage(`true`)}
	m.Mapping = map[string]string{"generate_audio": "@ignore", "private_note": "@reject"}
	m.Input = map[string]any{"generate_audio": true, "resolution": "stale", "private_note": "stale"}
	g.Modes["text_video"] = m
	doc.Groups["g"] = g
	for _, extra := range []map[string]any{{}, {"resolution": "720p"}, {"resolution": map[string]any{"bad": true}, "unknown": nil}, {"generate_audio": "not a boolean"}} {
		input := map[string]any{"prompt": "fixture", "seconds": float64(10), "seed": float64(0), "watermark": false}
		for field, value := range extra {
			input[field] = value
		}
		before := cloneMap(input)
		got, _, _, used, err := ResolveUnified(doc, "dynamic-model", "video_generate", input, false)
		require.NoError(t, err)
		require.True(t, used)
		require.Equal(t, map[string]any{"prompt": "fixture", "seconds": float64(10), "seed": float64(0), "watermark": false}, got)
		require.Equal(t, before, input)
	}
	for _, extra := range []map[string]any{{"seconds": float64(11)}, {"seconds": "bad"}, {"private_note": false}, {"seconds": float64(10), "duration": float64(11)}} {
		input := map[string]any{"prompt": "fixture"}
		for field, value := range extra {
			input[field] = value
		}
		_, _, _, _, err := ResolveUnified(doc, "dynamic-model", "video_generate", input, false)
		require.Error(t, err)
	}
	doc = unifiedFixture()
	// A field can remain in old parameter metadata after its capability is disabled.
	delete(doc.Bindings["dynamic-model"], "image_video")
	delete(doc.Bindings["dynamic-model"], "video_ref")
	g = doc.Groups["g"]
	m = g.Modes["text_video"]
	m.Parameters["images"] = Parameter{Type: "array"}
	g.Modes["text_video"] = m
	doc.Groups["g"] = g
	got, _, _, _, err := ResolveUnified(doc, "dynamic-model", "video_generate", map[string]any{"prompt": "fixture", "images": "bad ignored image", "start_image_url": false, "image[]": "ignored"}, false)
	require.NoError(t, err)
	require.NotContains(t, got, "images")
	require.NotContains(t, got, "start_image_url")
	require.NotContains(t, got, "image[]")

	doc = unifiedFixture()
	g = doc.Groups["g"]
	m = g.Modes["image_video"]
	m.Parameters["images"] = Parameter{Type: "array", Definition: map[string]any{"x-channel-parameter": map[string]any{"frameEncoding": map[string]any{"roleField": "role", "firstRole": "first", "lastRole": "last", "requiresFirstForLast": true}}}}
	g.Modes["image_video"] = m
	doc.Groups["g"] = g
	for _, input := range []map[string]any{
		{"prompt": "fixture", "images": []any{"ordinary image"}, "start_image_url": false, "end_image_url": "disabled"},
		{"prompt": "fixture", "end_image_url": "disabled"},
	} {
		got, _, _, _, err := ResolveUnified(doc, "dynamic-model", "video_generate", input, false)
		require.NoError(t, err)
		require.NotContains(t, got, "start_image_url")
		require.NotContains(t, got, "end_image_url")
		require.Equal(t, input["images"], got["images"], "disabled frame controls cannot become ordinary images")
	}
}

func TestUnifiedModelOptionalSubsetsAndValidation(t *testing.T) {
	doc := unifiedFixture()
	for _, refs := range []map[string]any{{}, {"images": []any{"one"}}, {"videos": []any{"video"}}, {"images": []any{"one"}, "videos": []any{"video"}}} {
		input := map[string]any{"prompt": "test"}
		for key, value := range refs {
			input[key] = value
		}
		got, _, _, used, err := ResolveUnified(doc, "dynamic-model", "video_generate", input, false)
		require.NoError(t, err)
		require.True(t, used)
		require.Equal(t, float64(5), got["seconds"])
		require.NotContains(t, got, "start_image_url")
		require.NotContains(t, got, "end_image_url")
	}
	_, _, _, _, err := ResolveUnified(doc, "dynamic-model", "video_generate", map[string]any{}, false)
	require.ErrorContains(t, err, "required parameter prompt")
	_, _, _, _, err = ResolveUnified(doc, "dynamic-model", "video_generate", map[string]any{"prompt": "test", "images": make([]any, 10)}, false)
	require.Error(t, err)
	input, _, _, _, err := ResolveUnified(doc, "dynamic-model", "video_generate", map[string]any{"prompt": "test", "unknown": 1}, false)
	require.NoError(t, err)
	require.NotContains(t, input, "unknown")
}

func TestUnifiedModelPriceAndPolicyConflicts(t *testing.T) {
	doc := unifiedFixture()
	for key, value := range doc.Bindings["dynamic-model"] {
		value.Billing = &Billing{Currency: "USD", Confirmed: true, Expression: `2 * u("request_count")`}
		doc.Bindings["dynamic-model"][key] = value
	}
	_, _, _, err := UnifiedModel(doc, "dynamic-model", "video_generate")
	require.NoError(t, err)
	b := doc.Bindings["dynamic-model"]["video_ref"]
	b.Billing.Expression = `3 * u("request_count")`
	_, _, _, err = UnifiedModel(doc, "dynamic-model", "video_generate")
	require.ErrorContains(t, err, "different saved prices")
	doc = unifiedFixture()
	b = doc.Bindings["dynamic-model"]["video_ref"]
	b.Mapping = map[string]string{"videos": "@reject"}
	doc.Bindings["dynamic-model"]["video_ref"] = b
	_, _, _, _, err = ResolveUnified(doc, "dynamic-model", "video_generate", map[string]any{"prompt": "test", "videos": []any{"video"}}, false)
	require.ErrorContains(t, err, "unsupported parameter videos")
}

func TestUnifiedSavedConfigurationReplay(t *testing.T) {
	path := os.Getenv("UNIFIED_CONFIG_REPLAY_FILE")
	if path == "" {
		t.Skip("explicit local configuration replay only")
	}
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var doc Document
	require.NoError(t, json.Unmarshal(raw, &doc))
	rows := []map[string]any{}
	for model := range doc.Bindings {
		definition, _, used, err := UnifiedModel(doc, model, "video_generate")
		require.NoError(t, err, model)
		require.True(t, used, model)
		cases := []map[string]any{{"prompt": "Isolated fixture only"}}
		if definition.Capabilities != nil {
			combined := map[string]any{"prompt": "Isolated fixture only"}
			for field, supported := range map[string]bool{"images": definition.Capabilities.Images, "videos": definition.Capabilities.Videos, "audios": definition.Capabilities.Audios} {
				if !supported {
					continue
				}
				value := []any{"https://cdn.invalid/fixture"}
				cases = append(cases, map[string]any{"prompt": "Isolated fixture only", field: value})
				combined[field] = value
			}
			if len(combined) > 1 {
				cases = append(cases, combined)
			}
		}
		for _, input := range cases {
			resolved, definition, _, _, err := ResolveUnified(doc, model, "video_generate", input, false)
			require.NoError(t, err, model)
			unrestricted := []string{}
			for field, parameter := range definition.Parameters {
				if UnrestrictedValueLimits(parameter) {
					unrestricted = append(unrestricted, field)
				}
			}
			rows = append(rows, map[string]any{"model": model, "input": resolved, "protocolTemplate": definition.Protocol.TemplateModel, "unrestrictedValueFields": unrestricted})
		}
	}
	if output := os.Getenv("UNIFIED_CONFIG_REPLAY_OUT"); output != "" {
		raw, err = json.Marshal(rows)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(output, raw, 0600))
	}
	t.Logf("resolved %d optional-input subsets across %d saved models", len(rows), len(doc.Bindings))
}
