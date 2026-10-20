package modelconfig

// UnrestrictedValueLimits is an explicit saved administrator choice. It does
// not disable required fields, wire types, material limits or billing checks.
func UnrestrictedValueLimits(parameter Parameter) bool {
	return parameter.Definition["x-business-allowed-values"] == "unlimited" &&
		(parameter.Required == nil || !*parameter.Required) &&
		parameter.Type != "array" && parameter.Type != "object"
}

func withoutValueLimits(parameter Parameter) Parameter {
	parameter.Enum = nil
	parameter.Minimum, parameter.Maximum = nil, nil
	parameter.Definition = schemaWithoutValueLimits(parameter.Definition)
	return parameter
}

func schemaWithoutValueLimits(schema map[string]any) map[string]any {
	result := make(map[string]any, len(schema))
	for key, value := range schema {
		switch key {
		case "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum":
			continue
		case "anyOf", "oneOf", "allOf":
			if options, ok := value.([]any); ok {
				copy := make([]any, len(options))
				for i, option := range options {
					if object, ok := option.(map[string]any); ok {
						copy[i] = schemaWithoutValueLimits(object)
					} else {
						copy[i] = option
					}
				}
				value = copy
			}
		}
		result[key] = value
	}
	return result
}
