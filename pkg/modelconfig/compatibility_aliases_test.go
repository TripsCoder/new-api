package modelconfig

import "testing"

func TestReviewedCompatibilityNamesAreExplicitAndProviderScoped(t *testing.T) {
	for alias, target := range map[string]string{"MiniMax-H3": "minimax-h3", "gpt-image-2-2k": "gpt-image-2-2K", "gpt-image-2-4k": "gpt-image-2-4K"} {
		if got := CanonicalReviewedModelName("zhangyuge_media", alias); got != target {
			t.Fatalf("%s maps to %s", alias, got)
		}
		if got := CanonicalReviewedModelName("xcmapi_media", alias); got != alias {
			t.Fatal("cross-provider alias mapping")
		}
	}
	if got := CanonicalReviewedModelName("zhangyuge_media", "MiniMax-h3"); got != "MiniMax-h3" {
		t.Fatal("guessed alias")
	}
}
