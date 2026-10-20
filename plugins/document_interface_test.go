package plugins

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/stretchr/testify/require"
)

func TestUnifiedOptionalFieldsUseSavedConfigurationAndPlugin(t *testing.T) {
	file := os.Getenv("UNIFIED_OPTIONAL_CONFIG_FILE")
	if file == "" {
		t.Skip("explicit isolated saved configuration required")
	}
	raw, err := os.ReadFile(file)
	require.NoError(t, err)
	var doc modelconfig.Document
	require.NoError(t, common.Unmarshal(raw, &doc))
	before, err := common.Marshal(doc)
	require.NoError(t, err)
	name := "seedance2-4-2-fast-720p"
	source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", "paisio_media.plugin.js"))
	require.NoError(t, err)
	plugin, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{Key: "paisio_media"})
	require.NoError(t, err)
	cases := []map[string]any{{}, {"resolution": "720p"}, {"resolution": map[string]any{"invalid": true}, "watermark": false, "unknown": "discard"}}
	if requestFile := os.Getenv("UNIFIED_OPTIONAL_REQUEST_FILE"); requestFile != "" {
		raw, err := os.ReadFile(requestFile)
		require.NoError(t, err)
		var actual map[string]any
		require.NoError(t, common.Unmarshal(raw, &actual))
		require.Contains(t, actual, "resolution")
		cases = append(cases, actual)
	}
	for _, fields := range cases {
		request := map[string]any{"prompt": "isolated fixture", "seconds": float64(10), "aspect_ratio": "3:4"}
		for field, value := range fields {
			request[field] = value
		}
		decoded, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_video", "decodeRequest"}, map[string]any{"model": name, "upstreamModel": name, "operation": "generate", "body": map[string]any{"kind": "json", "value": request}})
		require.NoError(t, err)
		original := decoded.(map[string]any)["requestBody"].(map[string]any)["input"].(map[string]any)
		effective, definition, _, unified, err := modelconfig.ResolveUnified(doc, name, "video_generate", original, false)
		require.NoError(t, err)
		require.True(t, unified)
		require.NotContains(t, effective, "resolution")
		require.NotContains(t, effective, "watermark")
		require.NotContains(t, effective, "unknown")
		unrestricted := []string{}
		for field, parameter := range definition.Parameters {
			if modelconfig.UnrestrictedValueLimits(parameter) {
				unrestricted = append(unrestricted, field)
			}
		}
		ctx := map[string]any{"model": name, "upstreamModel": name, "baseUrl": "https://provider.invalid", "apiKey": "isolated", "publicTaskId": "task_optional_fixture_001", "requestBody": map[string]any{"operation": "video_generate", "input": effective, "protocolTemplate": definition.Protocol.TemplateModel, "unrestrictedValueFields": unrestricted}}
		var descriptor map[string]any
		require.NoError(t, plugin.Engine.CallInto(t.Context(), &descriptor, "buildSubmitRequest", ctx))
		body := descriptor["body"].(map[string]any)
		require.Equal(t, "10", fmt.Sprint(body["duration"]))
		require.Equal(t, "3:4", body["aspect_ratio"])
		require.NotContains(t, body, "resolution")
		var usage map[string]any
		require.NoError(t, plugin.Engine.CallInto(t.Context(), &usage, "extractUsage", ctx))
		require.NotContains(t, usage, "resolution")
		capture := make(chan map[string]any, 1)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var captured map[string]any
			if err := common.DecodeJson(r.Body, &captured); err != nil {
				http.Error(w, "invalid mock JSON", http.StatusBadRequest)
				return
			}
			capture <- captured
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"isolated-only"}`))
		}))
		encoded, err := common.Marshal(body)
		require.NoError(t, err)
		response, err := http.Post(server.URL, "application/json", bytes.NewReader(encoded))
		require.NoError(t, err)
		_ = response.Body.Close()
		server.Close()
		require.Equal(t, http.StatusOK, response.StatusCode)
		captured := <-capture
		require.Equal(t, float64(10), captured["duration"])
		require.Equal(t, "3:4", captured["aspect_ratio"])
		require.NotContains(t, captured, "resolution")
	}
	for _, request := range []map[string]any{{"prompt": "fixture", "seconds": float64(11)}, {"prompt": "fixture", "seconds": "bad"}, {"prompt": "fixture", "aspect_ratio": float64(42)}, {"seconds": float64(10)}} {
		_, _, _, _, err := modelconfig.ResolveUnified(doc, name, "video_generate", request, false)
		require.Error(t, err)
	}
	effective, _, _, _, err := modelconfig.ResolveUnified(doc, name, "video_generate", map[string]any{"prompt": "fixture"}, false)
	require.NoError(t, err)
	require.NotContains(t, effective, "seconds", "no default may be invented for an absent optional field")
	after, err := common.Marshal(doc)
	require.NoError(t, err)
	require.Equal(t, string(before), string(after))
}

func TestManualMissingReferenceCapabilitySurvivesConfigurationAndWireConversion(t *testing.T) {
	raw, err := modelconfig.ProviderCatalog("xcmapi_media")
	require.NoError(t, err)
	interfaces := raw.(map[string]any)["interfaces"].(map[string]any)
	id := ""
	for key, value := range interfaces {
		entry := value.(map[string]any)
		if strings.Contains(entry["title"].(string), "QuickStart") {
			id = key
		}
	}
	require.NotEmpty(t, id)
	protocol := &modelconfig.ProtocolBinding{TemplateModel: id, Confirmed: true, Supplement: map[string]modelconfig.CapabilitySupplement{"video_ref": {Note: "Operator confirmed videos accepts URL objects", Fields: map[string]modelconfig.SupplementField{"videos": {Vendor: "reference_videos", Shape: "objects", MaxItems: 2}}}}}
	contract, err := modelconfig.InterfaceContract("xcmapi_media", id, "dola-seedance-2.0-933")
	require.NoError(t, err)
	contract, err = modelconfig.SupplementInterface(contract, protocol)
	require.NoError(t, err)
	parameters := map[string]modelconfig.Parameter{}
	for key, value := range contract["parameters"].(map[string]any) {
		data, err := common.Marshal(value)
		require.NoError(t, err)
		var p modelconfig.Parameter
		require.NoError(t, common.Unmarshal(data, &p))
		parameters[key] = p
	}
	d := modelconfig.Empty("xcmapi_media")
	d.Groups["g"] = modelconfig.Group{Modes: map[string]modelconfig.Mode{"text_video": {Enabled: true, StrictMapping: true, Parameters: parameters, Mapping: map[string]string{}, Input: map[string]any{}}, "video_ref": {Enabled: true, StrictMapping: true, Parameters: parameters, Mapping: map[string]string{}, Input: map[string]any{}}}}
	d.Bindings["dola-seedance-2.0-933"] = map[string]modelconfig.Binding{"text_video": {GroupID: "g", Protocol: protocol}, "video_ref": {GroupID: "g", Protocol: protocol}}
	require.NoError(t, modelconfig.Validate(d))
	encoded, err := common.Marshal(d)
	require.NoError(t, err)
	var reopened modelconfig.Document
	require.NoError(t, common.Unmarshal(encoded, &reopened))
	require.NoError(t, modelconfig.Validate(reopened))
	input, definition, _, unified, err := modelconfig.ResolveUnified(reopened, "dola-seedance-2.0-933", "video_generate", map[string]any{"prompt": "fixture", "videos": []any{map[string]any{"url": "https://media.example/ref.mp4"}}}, false)
	require.NoError(t, err)
	require.True(t, unified)
	source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", "xcmapi_media.plugin.js"))
	require.NoError(t, err)
	plugin, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{Key: "xcmapi_media"})
	require.NoError(t, err)
	ctx := map[string]any{"model": "dola-seedance-2.0-933", "upstreamModel": "dola-seedance-2.0-933", "baseUrl": "https://provider.invalid", "apiKey": "fixture", "publicTaskId": "task_manual_fixture_001", "requestBody": map[string]any{"operation": "video_generate", "input": input, "protocolTemplate": id, "manualInterfaceFields": modelconfig.ManualInterfaceFields(definition.Protocol)}}
	var descriptor map[string]any
	require.NoError(t, plugin.Engine.CallInto(t.Context(), &descriptor, "buildSubmitRequest", ctx))
	body := descriptor["body"].(map[string]any)
	require.Equal(t, "https://media.example/ref.mp4", body["reference_videos"].([]any)[0].(map[string]any)["url"])
	require.NotContains(t, body, "manualInterfaceFields")
	_, _, _, _, err = modelconfig.ResolveUnified(reopened, "dola-seedance-2.0-933", "video_generate", map[string]any{"prompt": "fixture", "videos": []any{"a", "b", "c"}}, false)
	require.Error(t, err)
	invalid := *protocol
	invalid.Supplement = map[string]modelconfig.CapabilitySupplement{"video_ref": {Note: "invalid", Fields: map[string]modelconfig.SupplementField{"videos": {Vendor: "authorization", Shape: "urls"}}}}
	_, err = modelconfig.SupplementInterface(contract, &invalid)
	require.Error(t, err)
	// No supplement cannot grant support, and a request cannot inject host metadata.
	delete(ctx["requestBody"].(map[string]any), "manualInterfaceFields")
	require.NoError(t, plugin.Engine.CallInto(t.Context(), &descriptor, "buildSubmitRequest", ctx))
	require.NotContains(t, descriptor["body"], "reference_videos")
}

// Exercise the real Go JS engine, not a page label or JavaScript-only replay.
func TestDocumentInterfacesConvertActualIDsWithoutExampleModelTemplates(t *testing.T) {
	for _, key := range []string{"paisio_media", "yuxibox_media", "xcmapi_media", "artbox_media", "lxmone_media", "zhangyuge_media"} {
		source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", key+".plugin.js"))
		require.NoError(t, err)
		plugin, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{Key: key})
		require.NoError(t, err)
		require.NotEmpty(t, plugin.Meta.ParameterInterfaces)
		registry := jsplugin.NewRegistry()
		_, err = registry.Register(string(source), jsplugin.Options{Key: key})
		require.NoError(t, err)
		generation := registry.Generation()
		for id, raw := range plugin.Meta.ParameterInterfaces {
			entry := raw.(map[string]any)
			t.Run(key+"/"+id, func(t *testing.T) {
				name := "actual-fetched-model-not-in-document-examples"
				input := map[string]any{"prompt": "Isolated fixture"}
				parameters := entry["parameters"].(map[string]any)
				if parameter, ok := parameters["seconds"].(map[string]any); ok && parameter["required"] == true {
					input["seconds"] = float64(6)
				}
				operation := "video_generate"
				if entry["kind"] == "image" {
					operation = "image_generate"
				}
				if strings.HasSuffix(entry["path"].(string), "/edits") {
					operation = "image_edit"
					input["images"] = []any{"https://media.example.com/reference.png"}
				}
				path, mode := "/v1/videos", "text_video"
				if entry["kind"] == "image" {
					path = "/v1/images/generations"
					mode = "text_image"
				}
				if operation == "image_edit" {
					path = "/v1/images/edits"
					mode = "edit_image"
				}
				_, automatic := generation.LookupEndpoint("POST", path, name)
				require.False(t, automatic, "documentation must not auto-route a discovered ID")
				endpoint, bound := generation.LookupConfiguredInterface(key, id, mode, "POST", path, name)
				require.True(t, bound)
				require.True(t, endpoint.ConfigurationBound)
				require.Equal(t, name, endpoint.Model)
				ctx := map[string]any{"model": name, "upstreamModel": name, "baseUrl": "https://provider.invalid", "apiKey": "isolated-test-only", "publicTaskId": "task_document_contract_fixture_0001", "requestBody": map[string]any{"operation": operation, "input": input, "uploads": []any{}, "protocolTemplate": id}}
				var descriptor map[string]any
				require.NoError(t, plugin.Engine.CallInto(t.Context(), &descriptor, "buildSubmitRequest", ctx))
				body := descriptor["body"].(map[string]any)
				if strings.Contains(entry["path"].(string), "{model}") {
					require.Contains(t, descriptor["url"], name)
				} else {
					require.Equal(t, name, body["model"])
				}
				if entry["kind"] == "video" {
					require.NotContains(t, body, "quality")
					require.NotContains(t, body, "n")
				}
			})
		}
	}
}
