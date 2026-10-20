package modelconfig

import "errors"

// InputCheckDocument isolates the current model without changing its draft or
// asserting interface applicability. Saving and execution still use Validate
// and ValidateProtocolBinding, which require that assertion.
func InputCheckDocument(document Document, model string) (Document, error) {
	bindings, ok := document.Bindings[model]
	if !ok || len(bindings) == 0 {
		return Document{}, errors.New("selected model has no configuration")
	}
	scoped := document
	scoped.Groups = map[string]Group{}
	scoped.Bindings = map[string]map[string]Binding{model: {}}
	// Keep all modes of this model: actual reference inputs can select a richer
	// enabled mode. Unrelated modes in a shared group belong to other models.
	for mode, binding := range bindings {
		scoped.Bindings[model][mode] = binding
		group, exists := document.Groups[binding.GroupID]
		if !exists {
			continue // normal structural validation reports the missing reference
		}
		copy, exists := scoped.Groups[binding.GroupID]
		if !exists {
			copy = group
			copy.Modes = map[string]Mode{}
		}
		if definition, exists := group.Modes[mode]; exists {
			copy.Modes[mode] = definition
		}
		scoped.Groups[binding.GroupID] = copy
	}
	return scoped, validateDocument(scoped, false)
}
