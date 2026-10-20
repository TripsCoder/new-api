package modelconfig

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
	"testing"
)

func interfaceFixture(t *testing.T) Document {
	t.Helper()
	document := Empty("paisio_media")
	raw, err := ProviderCatalog(document.Provider)
	require.NoError(t, err)
	interfaces := raw.(map[string]any)["interfaces"].(map[string]any)
	for id, raw := range interfaces {
		entry := raw.(map[string]any)
		if entry["path"] != "/v1/videos" {
			continue
		}
		parameters := map[string]Parameter{}
		mapping := map[string]string{}
		for field, raw := range entry["parameters"].(map[string]any) {
			var parameter Parameter
			data, _ := common.Marshal(raw)
			require.NoError(t, common.Unmarshal(data, &parameter))
			membership := parameter.Definition["x-channel-parameter"].(map[string]any)
			if membership["capabilities"].([]any)[0] != "base" {
				continue
			}
			parameters[field] = parameter
			mapping[field] = field
		}
		document.Groups["g"] = Group{Name: "Actual fetched ID", Modes: map[string]Mode{"text_video": {Enabled: true, StrictMapping: true, Input: map[string]any{}, Parameters: parameters, Mapping: mapping}}}
		document.Bindings["actual-fetched-ID"] = map[string]Binding{"text_video": {GroupID: "g", Protocol: &ProtocolBinding{TemplateModel: id, Confirmed: true}}}
		return document
	}
	t.Fatal("missing documented video interface")
	return document
}

func TestInterfaceAliasesRespectTheSameOptionalPolicy(t *testing.T) {
	document := interfaceFixture(t)
	require.NoError(t, Validate(document))
	request := map[string]any{"prompt": "fixture", "duration": float64(6)}
	input, _, err := Resolve(document, "actual-fetched-ID", "text_video", request)
	require.NoError(t, err)
	require.Equal(t, float64(6), input["seconds"])
	require.NotContains(t, input, "duration")
	mode := document.Groups["g"].Modes["text_video"]
	mode.Mapping["seconds"] = "@ignore"
	input, _, err = Resolve(document, "actual-fetched-ID", "text_video", request)
	require.NoError(t, err)
	require.NotContains(t, input, "seconds")
	mode.Mapping["seconds"] = "@reject"
	_, _, err = Resolve(document, "actual-fetched-ID", "text_video", request)
	require.ErrorContains(t, err, "unsupported parameter seconds")
}

func TestInterfaceSaveProtectsRequiredFieldsAndDocumentCandidates(t *testing.T) {
	document := interfaceFixture(t)
	mode := document.Groups["g"].Modes["text_video"]
	mode.Mapping["prompt"] = "@ignore"
	require.ErrorContains(t, Validate(document), "required document rules")
	mode.Mapping["prompt"] = "prompt"
	parameter := mode.Parameters["aspect_ratio"]
	parameter.Enum = []any{"99:1"}
	mode.Parameters["aspect_ratio"] = parameter
	require.ErrorContains(t, Validate(document), "candidate exceeds documentation")
}

func TestDocumentedTypedFrameReferencesRemainOneCapability(t *testing.T) {
	parameters := map[string]Parameter{"images": {Definition: map[string]any{"x-channel-parameter": map[string]any{"frameEncoding": map[string]any{"roleField": "type", "firstRole": "first_frame", "lastRole": "end_frame", "requiresFirstForLast": true}}}}}
	input, err := normalizeInterfaceAliases(map[string]any{"start_image_url": "https://media.example/first.png", "end_image_url": "https://media.example/last.png"}, parameters)
	require.NoError(t, err)
	references := input["images"].([]any)
	require.Equal(t, "first_frame", references[0].(map[string]any)["type"])
	require.Equal(t, "end_frame", references[1].(map[string]any)["type"])
	require.Equal(t, "frames", InferMode("video_generate", input))
	_, err = normalizeInterfaceAliases(map[string]any{"end_image_url": "https://media.example/last.png"}, parameters)
	require.ErrorContains(t, err, "requires a first frame")
}
