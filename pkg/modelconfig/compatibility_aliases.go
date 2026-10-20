package modelconfig

// Explicit existing gateway names resolve only within their own provider.
// Other providers keep their declared spelling and upstream execution identity.
func CanonicalReviewedModelName(provider, model string) string {
	if provider == "zhangyuge_media" {
		switch model {
		case "MiniMax-H3":
			return "minimax-h3"
		case "gpt-image-2-2k":
			return "gpt-image-2-2K"
		case "gpt-image-2-4k":
			return "gpt-image-2-4K"
		}
	}
	return model
}

// Explicit compatibility window; retained v2.0.0 snapshots remain executable.
func ReviewedPluginVersion(version string) bool {
	return version == "2.0.0" || version == "2.0.1" || version == "2.0.2" || version == "2.1.0" || version == "2.1.1" || version == "2.1.2" || version == "2.1.3" || version == "2.1.4" || version == "2.1.5"
}
