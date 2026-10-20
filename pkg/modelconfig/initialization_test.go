package modelconfig

import (
	"github.com/QuantumNous/new-api/common"
	"os"
	"testing"
)

func TestSixProviderInitializationDrafts(t *testing.T) {
	raw, err := os.ReadFile("../../plugin-sources/media-providers/six-v2/initial-configurations.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Format          string              `json:"format"`
		Status          string              `json:"status"`
		PreserveKeys    bool                `json:"preserveKeys"`
		MutatesDatabase bool                `json:"mutatesDatabase"`
		Configurations  map[string]Document `json:"configurations"`
	}
	if err = common.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if file.Status != "review-plan-requires-real-discovery-and-interface-confirmation" || !file.PreserveKeys || file.MutatesDatabase || len(file.Configurations) != 6 {
		t.Fatal("unsafe initialization artifact")
	}
	for key, document := range file.Configurations {
		if !SupportedProvider(key) || document.Provider != key || document.Revision != 0 {
			t.Fatal("unexpected provider scope")
		}
		if err = Validate(document); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if len(document.Bindings) != 0 || len(document.Groups) != 0 {
			t.Fatal("document examples must not initialize actual model bindings")
		}
		for _, group := range document.Groups {
			for _, mode := range group.Modes {
				if !mode.Enabled || mode.Cost.Confirmed || mode.Cost.Amount != nil {
					t.Fatal("review plan disabled a documented mode or invented an account price")
				}
			}
		}
	}
}

func TestNativeH3GeneratedSchemaRetainsObjectRequiredAndOptionalPrompt(t *testing.T) {
	raw, err := os.ReadFile("../../plugin-sources/media-providers/six-v2/evidence/legacy-initial-configurations-2.0.2.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Configurations map[string]Document `json:"configurations"`
	}
	if err = common.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	document := file.Configurations["xcmapi_media"]
	if _, _, err = Resolve(document, "h3", "text_video", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = Resolve(document, "h3", "image_video", map[string]any{"reference_images": []any{map[string]any{"missing_url": "x"}}}); err == nil {
		t.Fatal("lost nested required URL")
	}
	if _, _, err = Resolve(document, "h3", "audio_ref", map[string]any{"reference_audios": []any{map[string]any{"voice_id": "eve"}}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = Resolve(document, "h3", "audio_ref", map[string]any{"reference_audios": []any{map[string]any{"url": "https://media.example.com/custom.mp3"}}}); err == nil {
		t.Fatal("custom audio is not the preset contract")
	}
}
