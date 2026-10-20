package modelconfig

import (
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

func unconfirmedModelInterface(model string) error {
	return common.NewMessage("Model {{model}} / field protocol: confirm protocol applicability before saving a manual binding", map[string]any{"model": model})
}

// A manual binding selects compiled provider code, never user supplied scripts,
// URLs, credentials or output selectors. Confirmation is a contract assertion,
// not account availability or a successful supplier test.
func ValidateProtocolBinding(provider, mode string, binding *ProtocolBinding) error {
	return validateProtocolBinding(provider, mode, binding, true)
}

func validateProtocolBinding(provider, mode string, binding *ProtocolBinding, requireConfirmation bool) error {
	if binding == nil {
		return nil
	}
	if requireConfirmation && !binding.Confirmed {
		return errors.New("confirm protocol applicability before saving a manual binding")
	}
	raw, err := ProviderCatalog(provider)
	if err != nil {
		return err
	}
	catalog, ok := raw.(map[string]any)
	if !ok {
		return errors.New("invalid protocol catalog")
	}
	models, _ := catalog["models"].(map[string]any)
	entry, _ := models[binding.TemplateModel].(map[string]any)
	if interfaces, ok := catalog["interfaces"].(map[string]any); ok {
		if value, exists := interfaces[binding.TemplateModel].(map[string]any); exists {
			entry = value
		}
	}
	modes, _ := entry["modes"].(map[string]any)
	if len(binding.Supplement) > 0 {
		if !strings.HasPrefix(binding.TemplateModel, "interface:") {
			return errors.New("manual supplement requires a documented interface")
		}
		for capability := range binding.Supplement {
			if (capability == "edit_image") != (entry["kind"] == "image") {
				return errors.New("manual capability and output type do not match")
			}
		}
		_, err = SupplementInterface(map[string]any{"parameters": map[string]any{}, "modes": map[string]any{}}, binding)
		if err != nil {
			return err
		}
		if _, ok := binding.Supplement[mode]; ok {
			modes = map[string]any{mode: map[string]any{}}
		}
	}
	if _, ok := modes[mode]; !ok || mode == "unadapted" {
		return errors.New("selected protocol template does not implement this generation mode")
	}
	return nil
}

func ManualProtocolFor(document Document, model, mode string) *ProtocolBinding {
	binding, ok := document.Bindings[model][mode]
	if !ok {
		return nil
	}
	definition, ok := document.Groups[binding.GroupID].Modes[mode]
	if binding.Protocol != nil {
		definition.Protocol = binding.Protocol
	}
	if !ok || !definition.Enabled || binding.Enabled != nil && !*binding.Enabled || definition.Protocol == nil {
		return nil
	}
	if ValidateProtocolBinding(document.Provider, mode, definition.Protocol) != nil {
		return nil
	}
	return definition.Protocol
}

// Missing discovery is not a negative contract signal. Only explicit current
// supplier rejection states prevent an otherwise configured attempt.
func XCMExplicitlyUnavailable(status string) bool {
	return status == "preparing" || status == "maintenance" || status == "unavailable"
}

// ProtocolContractHint carries a compiled frame-only contract's private mode
// distinction through the host overlay without accepting a client mode switch.
func ProtocolContractHint(provider string, binding *ProtocolBinding) string {
	if binding == nil {
		return ""
	}
	raw, err := ProviderCatalog(provider)
	if err != nil {
		return ""
	}
	catalog, _ := raw.(map[string]any)
	models, _ := catalog["models"].(map[string]any)
	entry, _ := models[binding.TemplateModel].(map[string]any)
	if interfaces, ok := catalog["interfaces"].(map[string]any); ok {
		if value, exists := interfaces[binding.TemplateModel].(map[string]any); exists {
			entry = value
		}
	}
	modes, _ := entry["modes"].(map[string]any)
	_, frames := modes["frames"]
	_, reference := modes["image_video"]
	if frames && !reference {
		return "frames"
	}
	return ""
}
