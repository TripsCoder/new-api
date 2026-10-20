package controller

import (
	"errors"
	"regexp"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

var configurationInputFieldErrors = []struct {
	pattern *regexp.Regexp
	message string
}{
	{regexp.MustCompile(`[^\s/]+/[^\s/]+/([^\s/:]+): (?:required document rules must be retained|bounds exceed documentation|field is absent from documentation)`), "Model {{model}} / field {{field}}: the configuration conflicts with the documented required fields, bounds or field ownership"},
	{regexp.MustCompile(`(?:unmapped unsupported parameter |field absent from the selected document interface: |unsupported field: )([\w.\[\]-]+)`), "Model {{model}} / field {{field}}: the selected document interface does not declare this field; remove it or explicitly ignore it"},
	{regexp.MustCompile(`(?:required parameter |required documented field is missing: )([\w.\[\]-]+)`), "Model {{model}} / field {{field}}: a required value is missing"},
	{regexp.MustCompile(`(?:invalid value for parameter |invalid option for parameter |unsupported parameter type for )([\w.\[\]-]+)`), "Model {{model}} / field {{field}}: the value does not match the configured type, choices or range"},
	{regexp.MustCompile(`([\w.\[\]-]+) (?:is outside (?:documented candidate values|the documented range)|must exceed the documented minimum)`), "Model {{model}} / field {{field}}: the value is outside the documented choices or range; check allowed values or configure no value restrictions for this optional field"},
	{regexp.MustCompile(`([\w.\[\]-]+) (?:must be |does not match a documented input shape|violates documented length|exceeds documented reference limit|only accepts one reference)`), "Model {{model}} / field {{field}}: the value does not match the documented type, format or material limits"},
	{regexp.MustCompile(`([\w.\[\]-]+) is required`), "Model {{model}} / field {{field}}: a required value is missing"},
	{regexp.MustCompile(`(?:unsupported parameter |conflicting parameter mapping |conflicting documented aliases for )([\w.\[\]-]+)`), "Model {{model}} / field {{field}}: the field is rejected or its mappings or aliases conflict"},
	{regexp.MustCompile(`input capability is disabled: ([\w]+)`), "Model {{model}} / field {{field}}: this reference capability is not enabled"},
}

// Errors stay local to the offline endpoint. The message envelope reuses the
// console's locale handling; supplier and real relay error behavior is intact.
func modelConfigurationInputError(model string, err error) error {
	var message *common.Message
	if errors.As(err, &message) {
		return err
	}
	text := err.Error()
	for _, rule := range configurationInputFieldErrors {
		if match := rule.pattern.FindStringSubmatch(text); match != nil {
			return common.NewMessage(rule.message, map[string]any{"model": model, "field": match[1]})
		}
	}
	field, key := "configuration", "Model {{model}} / configuration: input checking failed; check this model's configuration. Details: {{detail}}"
	switch {
	case strings.Contains(text, "selected model has no configuration"):
		field, key = "model", "Model {{model}} / field {{field}}: this model is not in the current configuration; select and configure it first"
	case strings.Contains(text, "protocol"), strings.Contains(text, "interface"):
		field, key = "protocol", "Model {{model}} / field {{field}}: select a documented interface that supports the current generation mode; confirm applicability when checking and saving"
	case strings.Contains(text, "frame"):
		field, key = "images", "Model {{model}} / field {{field}}: frame references conflict or a required frame is missing; check the enabled frame capabilities"
	case strings.Contains(text, "generation mode"), strings.Contains(text, "request inputs are not enabled"), strings.Contains(text, "Input references do not match"):
		field, key = "capabilities", "Model {{model}} / field {{field}}: the input references do not match this model's enabled generation capabilities"
	}
	return common.NewMessage(key, map[string]any{"model": model, "field": field, "detail": text})
}
