package modelconfig

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
	"testing"
)

func fixture() Document {
	d := Empty("paisio_media")
	d.Groups["shared"] = Group{Name: "Shared", Modes: map[string]Mode{"text_image": {Enabled: true, Input: map[string]any{"n": float64(1), "async": true, "nested": map[string]any{"keep": true}}, Parameters: map[string]Parameter{}, Mapping: map[string]string{}}}}
	d.Bindings["a"] = map[string]Binding{"text_image": {GroupID: "shared"}}
	d.Bindings["b"] = map[string]Binding{"text_image": {GroupID: "shared"}}
	return d
}

func TestReviewedVideoDocumentInterfacesSupportDiscoveredModelsWithoutInventedDefaults(t *testing.T) {
	for _, provider := range []string{"aotian_video", "fenglang_video"} {
		t.Run(provider, func(t *testing.T) {
			require.NoError(t, Validate(Empty(provider)))
			raw, err := ProviderCatalog(provider)
			require.NoError(t, err)
			catalog := raw.(map[string]any)
			require.Empty(t, catalog["models"], "documentation must not populate account model discovery")
			interfaces := catalog["interfaces"].(map[string]any)
			require.Len(t, interfaces, 1)
			var interfaceID string
			for key := range interfaces {
				interfaceID = key
			}
			protocol := &ProtocolBinding{TemplateModel: interfaceID, Confirmed: true}
			require.NoError(t, ValidateProtocolBinding(provider, "text_video", protocol))
			protocol.Confirmed = false
			require.Error(t, ValidateProtocolBinding(provider, "text_video", protocol))
			protocol.Confirmed = true
			document := Empty(provider)
			document.Groups["selected"] = Group{Modes: map[string]Mode{"text_video": {
				Enabled: true, Protocol: protocol, StrictMapping: true,
				Parameters: map[string]Parameter{"prompt": {Type: "string", Required: boolPointer(true)}, "seconds": {Type: "integer"}},
			}}}
			document.Bindings["actual-account-model"] = map[string]Binding{"text_video": {GroupID: "selected"}}
			input, _, _, unified, err := ResolveUnified(document, "actual-account-model", "video_generate", map[string]any{"prompt": "Fixture", "images": false, "generate_audio": "ignored"}, false)
			require.NoError(t, err)
			require.True(t, unified)
			require.Equal(t, map[string]any{"prompt": "Fixture"}, input)
		})
	}
}
func TestFenglangDocumentedModelsCanSaveAndResolveFramePolicies(t *testing.T) {
	raw, err := ProviderCatalog("fenglang_video")
	require.NoError(t, err)
	interfaces := raw.(map[string]any)["interfaces"].(map[string]any)
	var id string
	for key := range interfaces {
		id = key
	}
	for _, name := range []string{"seedance-2.5", "seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini", "minimax-video-h3"} {
		t.Run(name, func(t *testing.T) {
			contract, err := InterfaceContract("fenglang_video", id, name)
			require.NoError(t, err)
			data, err := common.Marshal(contract["parameters"])
			require.NoError(t, err)
			parameters := map[string]Parameter{}
			require.NoError(t, common.Unmarshal(data, &parameters))
			document := Empty("fenglang_video")
			document.Groups["selected"] = Group{Modes: map[string]Mode{"frames": {Enabled: true, StrictMapping: true, Parameters: parameters, Protocol: &ProtocolBinding{TemplateModel: id, Confirmed: true}, Capabilities: &InputCapabilities{FirstFrame: true, LastFrame: true}}}}
			document.Bindings[name] = map[string]Binding{"frames": {GroupID: "selected"}}
			require.NoError(t, Validate(document))
			// The decoder maps supplier input_reference to start_image_url first;
			// disabling reference images must retain that distinct frame role.
			input, _, _, unified, err := ResolveUnified(document, name, "video_generate", map[string]any{"prompt": "Fixture", "seconds": 5, "start_image_url": "https://media.example/start.png", "images": false}, false)
			require.NoError(t, err)
			require.True(t, unified)
			require.Equal(t, "https://media.example/start.png", input["start_image_url"])
			require.NotContains(t, input, "images")
		})
	}
}
func TestSharedReferencesAndMemberExceptions(t *testing.T) {
	d := fixture()
	b := d.Bindings["b"]["text_image"]
	b.Input = map[string]any{"n": float64(2)}
	d.Bindings["b"]["text_image"] = b
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	m.Input["n"] = float64(3)
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	a, _, err := Resolve(d, "a", "text_image", nil)
	if err != nil || a["n"] != float64(3) {
		t.Fatal(a, err)
	}
	other, _, _ := Resolve(d, "b", "text_image", nil)
	if other["n"] != float64(2) {
		t.Fatal(other)
	}
	a["n"] = float64(99)
	if m.Input["n"] != float64(3) {
		t.Fatal("resolved result changed shared data")
	}
}
func TestExplicitZeroFalseAndArrays(t *testing.T) {
	d := fixture()
	input, _, err := Resolve(d, "a", "text_image", map[string]any{"n": 0, "async": false, "nested": map[string]any{"extra": 0}, "refs": []any{"one"}})
	if err != nil || input["n"] != float64(0) || input["async"] != false {
		t.Fatal(input, err)
	}
	nested := input["nested"].(map[string]any)
	if nested["keep"] != true || nested["extra"] != float64(0) {
		t.Fatal(nested)
	}
}
func TestIndependentModesAndDisable(t *testing.T) {
	d := fixture()
	g := d.Groups["shared"]
	g.Modes["edit_image"] = Mode{Enabled: false, Input: map[string]any{"n": float64(4)}}
	d.Groups["shared"] = g
	d.Bindings["a"]["edit_image"] = Binding{GroupID: "shared"}
	if _, _, err := Resolve(d, "a", "edit_image", nil); err == nil {
		t.Fatal("disabled mode accepted")
	}
	if _, _, err := Resolve(d, "a", "text_image", nil); err != nil {
		t.Fatal(err)
	}
}
func TestValidationAndNoCredentialImport(t *testing.T) {
	d := fixture()
	if err := Validate(d); err != nil {
		t.Fatal(err)
	}
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	m.Input["api_key"] = "secret"
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	if err := Validate(d); err == nil {
		t.Fatal("credential accepted")
	}
	delete(m.Input, "api_key")
	m.Input["__proto__"] = map[string]any{}
	if err := Validate(d); err == nil {
		t.Fatal("prototype accepted")
	}
}
func TestExplicitDefaultsAndBounds(t *testing.T) {
	d := fixture()
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	one := 1.0
	m.Parameters = map[string]Parameter{"n": {Type: "integer", Minimum: &one, Default: []byte("1")}, "async": {Type: "boolean", Default: []byte("true")}}
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	if _, _, err := Resolve(d, "a", "text_image", map[string]any{"n": 0}); err == nil {
		t.Fatal("zero silently defaulted")
	}
	v, _, err := Resolve(d, "a", "text_image", map[string]any{"async": false})
	if err != nil || v["async"] != false {
		t.Fatal(v, err)
	}
}
func TestMappingConflictsAndUnknownPreservation(t *testing.T) {
	d := fixture()
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	m.Mapping = map[string]string{"imageSize": "image_size", "async": "@ignore"}
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	v, _, err := Resolve(d, "a", "text_image", map[string]any{"imageSize": "2K", "custom": false})
	if err != nil || v["image_size"] != "2K" || v["custom"] != false {
		t.Fatal(v, err)
	}
	if _, ok := v["async"]; ok {
		t.Fatal("ignore not applied")
	}
	if _, _, err = Resolve(d, "a", "text_image", map[string]any{"imageSize": "2K", "image_size": "4K"}); err == nil {
		t.Fatal("mapping conflict accepted")
	}
}
func TestDocumentRoundTripAndBindings(t *testing.T) {
	d := fixture()
	raw, err := common.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	var next Document
	if err = common.Unmarshal(raw, &next); err != nil {
		t.Fatal(err)
	}
	if err = Validate(next); err != nil {
		t.Fatal(err)
	}
	next.Bindings["a"]["text_image"] = Binding{GroupID: "missing"}
	if err = Validate(next); err == nil {
		t.Fatal("broken reference accepted")
	}
}

func TestSimultaneousMappingAndDefaults(t *testing.T) {
	for i := 0; i < 100; i++ {
		v, err := applyMapping(map[string]any{"a": float64(1)}, map[string]string{"a": "b", "b": "c"})
		if err != nil || v["b"] != float64(1) || v["c"] != nil {
			t.Fatal(v, err)
		}
	}
	if _, err := applyMapping(map[string]any{"a": 1, "b": 2}, map[string]string{"a": "c", "b": "c"}); err == nil {
		t.Fatal("conflicting targets accepted")
	}
	d := fixture()
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	m.Parameters = map[string]Parameter{"alias": {Type: "integer", Default: []byte("3")}}
	m.Mapping = map[string]string{"alias": "parameters.seconds"}
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	v, _, err := Resolve(d, "a", "text_image", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := v["alias"]; ok {
		t.Fatal("mapping source default reappeared")
	}
	if value, ok := getPath(v, "parameters.seconds"); !ok || value != float64(3) {
		t.Fatal(v)
	}
	if _, err = applyMapping(map[string]any{"a": 1}, map[string]string{"a": "nested.__proto__.x"}); err == nil {
		t.Fatal("unsafe nested target accepted")
	}
}
func TestImportedSchemaRulesAreEnforced(t *testing.T) {
	tests := []struct {
		value  any
		schema map[string]any
	}{
		{[]any{"one", "two"}, map[string]any{"maxItems": float64(1)}},
		{[]any{"one", 1.0}, map[string]any{"items": map[string]any{"type": "string"}}},
		{"中文", map[string]any{"minLength": float64(3)}},
		{"invalid", map[string]any{"pattern": "^https://"}},
		{map[string]any{}, map[string]any{"required": []any{"url"}}},
		{float64(1), map[string]any{"oneOf": []any{}}},
	}
	for _, test := range tests {
		if err := validateSchemaRules("field", test.value, test.schema, 0); err == nil {
			t.Fatalf("invalid schema value accepted: %v", test)
		}
	}
	if err := validateParameter("field", true, Parameter{Type: "unknown"}); err == nil {
		t.Fatal("unknown type accepted")
	}
	if err := validateSchemaRules("field", "中文", map[string]any{"minLength": float64(2), "maxLength": float64(2)}, 0); err != nil {
		t.Fatal(err)
	}
}

func TestNestedObjectRequiredAndNullable(t *testing.T) {
	schema := map[string]any{"type": "array", "items": map[string]any{"type": "object", "required": []any{"url"}, "properties": map[string]any{"url": map[string]any{"type": "string", "minLength": float64(1)}, "note": map[string]any{"type": "string", "nullable": true}}}}
	if err := validateNestedSchema("refs", []any{map[string]any{"url": "https://example.com/ref.png", "note": nil}}, schema, 0); err != nil {
		t.Fatal(err)
	}
	if err := validateNestedSchema("refs", []any{map[string]any{"note": nil}}, schema, 0); err == nil {
		t.Fatal("required nested field missing")
	}
	if err := validateNestedSchema("refs", []any{map[string]any{"url": ""}}, schema, 0); err == nil {
		t.Fatal("empty nested URL accepted")
	}
}

func TestNestedPathsAndAdditionalProperties(t *testing.T) {
	d := fixture()
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	m.Parameters = map[string]Parameter{"options.seconds": {Type: "integer", Default: []byte("3")}}
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	value, _, err := Resolve(d, "a", "text_image", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := value["options.seconds"]; exists {
		t.Fatal("literal dotted key created")
	}
	if seconds, _ := getPath(value, "options.seconds"); seconds != float64(3) {
		t.Fatal(value)
	}
	if err = validateNestedSchema("options", map[string]any{"bad": true}, map[string]any{"type": "object", "additionalProperties": false}, 0); err == nil {
		t.Fatal("extra property accepted without properties map")
	}
	if err = validateNestedSchema("options", map[string]any{"bad": true}, map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}}, 0); err == nil {
		t.Fatal("extra property schema ignored")
	}
}

func TestFormScalarsPreserveExistingProtocol(t *testing.T) {
	d := fixture()
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	min, max := 1.0, 15.0
	m.Parameters = map[string]Parameter{"seconds": {Type: "integer", Minimum: &min, Maximum: &max}, "generate_audio": {Type: "boolean"}}
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	value, _, err := Resolve(d, "a", "text_image", map[string]any{"seconds": "5", "generate_audio": "false"}, true)
	if err != nil || value["seconds"] != float64(5) || value["generate_audio"] != false {
		t.Fatal(value, err)
	}
	for _, bad := range []string{"5.1", "NaN", "Infinity", "-1", "9007199254740992", "1e3", ""} {
		if _, _, err := Resolve(d, "a", "text_image", map[string]any{"seconds": bad}, true); err == nil {
			t.Fatalf("invalid form integer accepted: %s", bad)
		}
	}
	for _, bad := range []string{"False", "1", "", "yes"} {
		if _, _, err := Resolve(d, "a", "text_image", map[string]any{"generate_audio": bad}, true); err == nil {
			t.Fatal("invalid form boolean accepted")
		}
	}
	if _, _, err := Resolve(d, "a", "text_image", map[string]any{"seconds": "5"}); err == nil {
		t.Fatal("JSON types silently coerced")
	}
}
func TestExplicitAliasOverridesCanonicalDefault(t *testing.T) {
	d := fixture()
	g := d.Groups["shared"]
	m := g.Modes["text_image"]
	m.Input["image_size"] = "1K"
	m.Mapping = map[string]string{"imageSize": "image_size"}
	g.Modes["text_image"] = m
	d.Groups["shared"] = g
	value, _, err := Resolve(d, "a", "text_image", map[string]any{"imageSize": "2K"})
	if err != nil || value["image_size"] != "2K" {
		t.Fatal(value, err)
	}
}
func TestModeIncludesAllAcceptedReferenceSources(t *testing.T) {
	for _, key := range []string{"image", "images", "image[]", "input_reference", "image_url", "extra_images"} {
		if mode := InferMode("video_generate", map[string]any{key: []any{"https://example.com/a.png"}}); mode != "image_video" {
			t.Fatal(key, mode)
		}
	}
	for _, test := range []struct{ mime, mode string }{{"image/png", "image_video"}, {"video/mp4", "video_ref"}, {"audio/mpeg", "audio_ref"}} {
		if mode := InferMode("video_generate", map[string]any{}, []any{map[string]any{"mimeType": test.mime}}); mode != test.mode {
			t.Fatal(test, mode)
		}
	}
	if mode := InferMode("video_generate", map[string]any{"first_last_frame": "false"}); mode != "text_video" {
		t.Fatal(mode)
	}
}

func TestModeIncludesTypedMaterialsAndFrameObjects(t *testing.T) {
	for _, value := range []map[string]any{{"materials": []any{map[string]any{"type": "video", "url": "https://example.com/ref.mp4"}}}, {"materials": []any{map[string]any{"type": "audio", "url": "https://example.com/ref.mp3"}}}, {"images": []any{map[string]any{"url": "https://example.com/ref.png", "type": "first_frame"}}}} {
		mode := InferMode("video_generate", value)
		if mode == "text_video" || mode == "image_video" {
			t.Fatal("typed references misclassified", mode)
		}
	}
}

func TestContractFrameHintCannotBypassDisabledReferenceMode(t *testing.T) {
	require.Equal(t, "text_video", InferContractMode("video_generate", map[string]any{"prompt": "fixture"}, nil, "frames"))
	require.Equal(t, "frames", InferContractMode("video_generate", map[string]any{"images": []any{"https://media.example.com/ref.png"}}, nil, "frames"))
	require.Equal(t, "image_video", InferContractMode("video_generate", map[string]any{"images": []any{"https://media.example.com/ref.png"}, "contractMode": "frames"}, nil))
}

func TestMemberIgnoredAliasOverridesGroupModeInference(t *testing.T) {
	d := Empty("paisio_media")
	d.Groups["g"] = Group{Name: "g", Modes: map[string]Mode{"image_video": {Enabled: true, Input: map[string]any{}, Mapping: map[string]string{"custom_ref": "images"}}, "text_video": {Enabled: true, Input: map[string]any{}, Mapping: map[string]string{"custom_ref": "images"}}}}
	d.Bindings["m"] = map[string]Binding{"image_video": {GroupID: "g", Mapping: map[string]string{"custom_ref": "@ignore"}}, "text_video": {GroupID: "g", Mapping: map[string]string{"custom_ref": "@ignore"}}}
	input := map[string]any{"prompt": "fixture", "custom_ref": []any{"https://media.example.com/ref.png"}}
	mode, err := InferConfiguredMode(d, "m", "video_generate", input, nil)
	require.NoError(t, err)
	require.Equal(t, "text_video", mode)
	effective, _, err := Resolve(d, "m", mode, input)
	require.NoError(t, err)
	require.NotContains(t, effective, "custom_ref")
	require.NotContains(t, effective, "images")
}
