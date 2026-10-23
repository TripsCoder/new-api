package modelconfig

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestReviewedPluginVersionKeepsExplicitCompatibilityWindow(t *testing.T) {
	for _, version := range []string{"2.0.0", "2.0.1", "2.0.2", "2.1.0", "2.1.1", "2.1.2", "2.1.3", "2.1.4", "2.1.5", "2.1.6"} {
		assert.True(t, ReviewedPluginVersion(version), "retained version %s", version)
	}
	for _, version := range []string{"", "2.1.7", "2.2.0", "3.0.0", "2.1.6-beta.1", "v2.1.6", " 2.1.6"} {
		assert.False(t, ReviewedPluginVersion(version), "unreviewed version %s", version)
	}
}

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
