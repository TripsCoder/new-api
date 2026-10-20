// Package modelconfig owns channel-scoped model configuration without changing inference DTOs.
package modelconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
)

const Format = "channel-model-configuration/v1"
const ContextKeyRevision = "channel_model_configuration_revision"

var namePattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
var blocked = regexp.MustCompile(`(?i)^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie|credential|__proto__|prototype|constructor)$`)

type Source struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256,omitempty"`
	ReadAt string `json:"readAt,omitempty"`
	Scope  string `json:"scope,omitempty"`
	Status string `json:"status,omitempty"`
}
type Parameter struct {
	Definition  map[string]any  `json:"definition,omitempty"`
	Type        string          `json:"type,omitempty"`
	Required    *bool           `json:"required,omitempty"`
	Default     json.RawMessage `json:"default,omitempty"`
	Enum        []any           `json:"enum,omitempty"`
	Minimum     *float64        `json:"minimum,omitempty"`
	Maximum     *float64        `json:"maximum,omitempty"`
	Description string          `json:"description,omitempty"`
	Source      *Source         `json:"source,omitempty"`
}
type Cost struct {
	Amount     *float64 `json:"amount"`
	Unit       string   `json:"unit,omitempty"`
	Currency   string   `json:"currency,omitempty"`
	Confirmed  bool     `json:"confirmed"`
	Expression string   `json:"expression,omitempty"`
	Source     *Source  `json:"source,omitempty"`
}
type ProtocolBinding struct {
	TemplateModel string                          `json:"templateModel"`
	Confirmed     bool                            `json:"confirmed"`
	Supplement    map[string]CapabilitySupplement `json:"supplement,omitempty"`
}

// CapabilitySupplement records an administrator's explicit missing-field contract.
// It cannot change the endpoint, credentials or existing document constraints.
type CapabilitySupplement struct {
	Note   string                     `json:"note"`
	Fields map[string]SupplementField `json:"fields"`
}
type SupplementField struct {
	Vendor   string `json:"vendor"`
	Shape    string `json:"shape"`
	MaxItems int    `json:"maxItems,omitempty"`
}

type InputCapabilities struct {
	Images     bool `json:"images"`
	Videos     bool `json:"videos"`
	Audios     bool `json:"audios"`
	FirstFrame bool `json:"firstFrame,omitempty"`
	LastFrame  bool `json:"lastFrame,omitempty"`
}
type Mode struct {
	StrictMapping bool                 `json:"strictMapping,omitempty"`
	Capabilities  *InputCapabilities   `json:"capabilities,omitempty"`
	Protocol      *ProtocolBinding     `json:"protocol,omitempty"`
	Enabled       bool                 `json:"enabled"`
	Input         map[string]any       `json:"input"`
	Parameters    map[string]Parameter `json:"parameters,omitempty"`
	Mapping       map[string]string    `json:"mapping,omitempty"`
	Cost          Cost                 `json:"cost"`
	Billing       *Billing             `json:"billing,omitempty"`
	Source        *Source              `json:"source,omitempty"`
}
type Group struct {
	Name  string          `json:"name"`
	Modes map[string]Mode `json:"modes"`
}
type PricingRule struct {
	Method string   `json:"method"`
	Value  *float64 `json:"value"`
}
type Binding struct {
	Capabilities *InputCapabilities   `json:"capabilities,omitempty"`
	Pricing      *PricingRule         `json:"pricing,omitempty"`
	Protocol     *ProtocolBinding     `json:"protocol,omitempty"`
	GroupID      string               `json:"groupId"`
	Parameters   map[string]Parameter `json:"parameters,omitempty"`
	Cost         *Cost                `json:"cost,omitempty"`
	Billing      *Billing             `json:"billing,omitempty"`
	Enabled      *bool                `json:"enabled,omitempty"`
	Input        map[string]any       `json:"input,omitempty"`
	Mapping      map[string]string    `json:"mapping,omitempty"`
}
type Document struct {
	Format   string                        `json:"format"`
	Revision int64                         `json:"revision"`
	Provider string                        `json:"provider"`
	Groups   map[string]Group              `json:"groups"`
	Bindings map[string]map[string]Binding `json:"bindings"`
	Sources  []Source                      `json:"sources,omitempty"`
}

func Empty(provider string) Document {
	return Document{Format: Format, Provider: provider, Groups: map[string]Group{}, Bindings: map[string]map[string]Binding{}}
}

func Validate(document Document) error {
	return validateDocument(document, true)
}

func validateDocument(document Document, requireConfirmation bool) error {
	if document.Format != Format || document.Revision < 0 {
		return errors.New("invalid channel model configuration format")
	}
	if !namePattern.MatchString(document.Provider) || len(document.Groups) > 64 || len(document.Bindings) > 1000 {
		return errors.New("invalid configuration scope or size")
	}
	for key, group := range document.Groups {
		if !namePattern.MatchString(key) || len(group.Name) > 200 || len(group.Modes) > 16 {
			return errors.New("invalid shared configuration")
		}
		for mode, value := range group.Modes {
			if requireConfirmation && value.Protocol != nil && !value.Protocol.Confirmed {
				models := []string{}
				for model, bindings := range document.Bindings {
					if binding, ok := bindings[mode]; ok && binding.GroupID == key {
						models = append(models, model)
					}
				}
				sort.Strings(models)
				if len(models) == 0 {
					models = append(models, key)
				}
				return unconfirmedModelInterface(strings.Join(models, ", "))
			}
			if err := validateProtocolBinding(document.Provider, mode, value.Protocol, requireConfirmation); err != nil {
				return err
			}
			if !SupportedMode(mode) {
				return errors.New("invalid generation mode")
			}
			if err := ValidateBilling(value.Billing); err != nil {
				return err
			}
			if err := validateCost(value.Cost); err != nil {
				return err
			}
			for from, to := range value.Mapping {
				if !validPath(from) || (to != "@ignore" && to != "@reject" && !validPath(to)) {
					return errors.New("invalid parameter mapping")
				}
			}

			for key, parameter := range value.Parameters {
				if !namePattern.MatchString(key) || blocked.MatchString(key) {
					return errors.New("invalid parameter name")
				}
				if parameter.Minimum != nil && parameter.Maximum != nil && *parameter.Minimum > *parameter.Maximum {
					return errors.New("invalid parameter bounds")
				}
			}
		}
	}
	for model, modes := range document.Bindings {
		if strings.TrimSpace(model) == "" || len(model) > 256 || strings.ContainsAny(model, ",\r\n") || blocked.MatchString(model) || len(modes) > 16 {
			return errors.New("invalid model binding")
		}
		for key, binding := range modes {
			if rule := binding.Pricing; rule != nil {
				if rule.Method != "fixed_markup" && rule.Method != "percentage_markup" && rule.Method != "direct_price" {
					return errors.New("invalid markup method")
				}
				if rule.Value != nil && (*rule.Value < 0 || math.IsNaN(*rule.Value) || math.IsInf(*rule.Value, 0)) {
					return errors.New("invalid markup value")
				}
			}
			if requireConfirmation && binding.Protocol != nil && !binding.Protocol.Confirmed {
				return unconfirmedModelInterface(model)
			}
			if err := validateProtocolBinding(document.Provider, key, binding.Protocol, requireConfirmation); err != nil {
				return err
			}
			group, ok := document.Groups[binding.GroupID]
			if !ok {
				return errors.New("binding references missing shared configuration")
			}
			if _, ok = group.Modes[key]; !ok {
				return errors.New("binding references missing generation mode")
			}
			if err := ValidateBilling(binding.Billing); err != nil {
				return err
			}
			if binding.Cost != nil {
				if err := validateCost(*binding.Cost); err != nil {
					return err
				}
			}
			for name, parameter := range binding.Parameters {
				if !namePattern.MatchString(name) || blocked.MatchString(name) {
					return errors.New("invalid parameter name")
				}
				if parameter.Minimum != nil && parameter.Maximum != nil && *parameter.Minimum > *parameter.Maximum {
					return errors.New("invalid parameter bounds")
				}
			}
			for from, to := range binding.Mapping {
				if !validPath(from) || (to != "@ignore" && to != "@reject" && !validPath(to)) {
					return errors.New("invalid parameter mapping")
				}
			}

		}
	}
	raw, err := common.Marshal(document)
	if err != nil {
		return err
	}
	if len(raw) > 1<<20 {
		return errors.New("configuration exceeds 1 MB")
	}
	var value any
	if err = common.Unmarshal(raw, &value); err != nil {
		return err
	}
	if err := validateInterfaceParameters(document); err != nil {
		return err
	}
	count := 0
	return validateValue(value, 0, &count)
}

func validateValue(value any, depth int, count *int) error {
	*count++
	if depth > 20 || *count > 50000 {
		return errors.New("configuration is too deeply nested or too large")
	}
	switch value := value.(type) {
	case map[string]any:
		for key, item := range value {
			if blocked.MatchString(key) {
				return fmt.Errorf("remove credential or unsafe field %s", key)
			}
			if err := validateValue(item, depth+1, count); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range value {
			if err := validateValue(item, depth+1, count); err != nil {
				return err
			}
		}
	case string:
		if strings.HasPrefix(value, "Bearer ") || regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{12,}`).MatchString(value) {
			return errors.New("remove credentials from configuration")
		}
	}
	return nil
}

// Resolve preserves explicit false/zero and request values. Arrays replace atomically.
// Group edits remain shared references; a model binding contains only its exceptions.
func Resolve(document Document, model, mode string, request map[string]any, formInput ...bool) (map[string]any, Mode, error) {
	binding, exists := document.Bindings[model][mode]
	if !exists && len(document.Bindings[model]) > 0 {
		// Capability configuration accepts documented request subsets, while
		// retaining the configured validation/mapping/pricing instead of bypassing it.
		richer := []string{}
		switch mode {
		case "text_video":
			richer = []string{"mixed_ref", "video_ref", "audio_ref", "image_video", "frames"}
		case "image_video":
			richer = []string{"mixed_ref", "frames"}
		case "video_ref", "audio_ref":
			richer = []string{"mixed_ref"}
		case "text_image":
			richer = []string{"edit_image"}
		}
		for _, candidate := range richer {
			configured, ok := document.Bindings[model][candidate]
			if !ok {
				continue
			}
			definition, ok := document.Groups[configured.GroupID].Modes[candidate]
			if !ok || !definition.Enabled || configured.Enabled != nil && !*configured.Enabled {
				continue
			}
			binding = configured
			exists = true
			mode = candidate
			break
		}
		if !exists {
			return nil, Mode{}, errors.New("request inputs are not enabled for this configured model")
		}
	}
	if !exists {
		return cloneMap(request), Mode{}, nil
	}
	group, exists := document.Groups[binding.GroupID]
	if !exists {
		return nil, Mode{}, errors.New("shared configuration not found")
	}
	definition, exists := group.Modes[mode]
	if !exists {
		return nil, Mode{}, errors.New("generation mode not found")
	}
	if !definition.Enabled || binding.Enabled != nil && !*binding.Enabled {
		return nil, definition, errors.New("generation mode is disabled for this model")
	}
	if binding.Protocol != nil {
		definition.Protocol = binding.Protocol
	}
	definition.Parameters = mergeParameters(definition.Parameters, binding.Parameters)
	if binding.Billing != nil {
		definition.Billing = binding.Billing
	}
	if binding.Cost != nil {
		definition.Cost = *binding.Cost
	}
	if binding.Capabilities != nil {
		definition.Capabilities = binding.Capabilities
	}

	defaults := merge(definition.Input, binding.Input)
	mapping := map[string]string{}
	for key, value := range definition.Mapping {
		mapping[key] = value
	}
	for key, value := range binding.Mapping {
		mapping[key] = value
	}
	for key, parameter := range definition.Parameters {
		if key == "model" || parameter.Definition["serverGenerated"] == true {
			continue
		}
		if _, exists := getPath(defaults, key); !exists && len(parameter.Default) > 0 {
			var value any
			if err := common.Unmarshal(parameter.Default, &value); err != nil {
				return nil, definition, errors.New("invalid parameter default")
			}
			if err := setPath(defaults, key, value); err != nil {
				return nil, definition, err
			}
		}
	}
	interfaceProtocol := definition.Protocol != nil && strings.HasPrefix(definition.Protocol.TemplateModel, "interface:")
	if interfaceProtocol {
		// Capability switches and explicit ignore policies apply before alias
		// conflicts, type checks, defaults and provider request construction.
		if cap := definition.Capabilities; cap != nil {
			families := []struct {
				enabled bool
				fields  []string
			}{
				{cap.Images, []string{"images", "image", "image_url", "image_urls", "reference_images", "reference_image_urls", "input_reference", "extra_images"}},
				{cap.Videos, []string{"videos", "video_urls", "reference_videos", "reference_video_urls", "extra_videos"}},
				{cap.Audios, []string{"audios", "audio_urls", "reference_audios", "reference_audio_urls", "extra_audios", "audio_durations"}},
				{cap.FirstFrame, []string{"first_frame", "start_image_url"}},
				{cap.LastFrame, []string{"last_frame", "end_image_url", "first_last_frame"}},
			}
			for _, family := range families {
				if family.enabled {
					continue
				}
				for _, field := range family.fields {
					parameter := definition.Parameters[field]
					if mapping[field] != "@reject" && (parameter.Required == nil || !*parameter.Required) {
						mapping[field] = "@ignore"
					}
				}
			}
		}
		aliases := mergeParameters(definition.Parameters, nil)
		request = cloneMap(request)
		for field, policy := range mapping {
			if policy == "@ignore" {
				delete(aliases, field)
				// Remove disabled frame controls before reference aliases can
				// reinterpret them as supported ordinary images.
				deletePath(request, field)
				deletePath(defaults, field)
			}
		}
		var err error
		request, err = normalizeInterfaceAliases(request, aliases)
		if err != nil {
			return nil, definition, err
		}
		defaults, err = normalizeInterfaceAliases(defaults, aliases)
		if err != nil {
			return nil, definition, err
		}
	}
	if definition.StrictMapping || interfaceProtocol {
		request = cloneMap(request)
		for _, layer := range []map[string]any{defaults, request} {
			for field := range layer {
				if _, supported := definition.Parameters[field]; supported {
					continue
				}
				if _, mapped := mapping[field]; mapped {
					continue
				}
				supported := false
				for from, to := range mapping {
					if strings.HasPrefix(from, field+".") || to == field || strings.HasPrefix(to, field+".") {
						supported = true
						break
					}
				}
				if !supported {
					delete(layer, field)
				}
			}
		}
	}
	// Transform each layer before merging. An explicit request alias must win
	// over a default at its target, while conflicting explicit aliases reject.
	for field, policy := range mapping {
		if policy == "@reject" {
			// Rejection is about a supplied request field, not a stale default.
			deletePath(defaults, field)
		}
	}
	defaults, err := applyMapping(defaults, mapping)
	if err != nil {
		return nil, definition, err
	}
	explicit, err := applyMapping(cloneMap(request), mapping)
	if err != nil {
		return nil, definition, err
	}
	input := merge(defaults, explicit)
	if err := validateInputCapabilities(input, definition.Capabilities); err != nil {
		return nil, definition, err
	}
	for key, parameter := range definition.Parameters {
		if key == "model" || parameter.Definition["serverGenerated"] == true {
			continue
		}
		if target, present := mapping[key]; present {
			if target == "@ignore" || target == "@reject" {
				continue
			}
			key = target
		}
		value, exists := getPath(input, key)
		if !exists {
			if parameter.Required != nil && *parameter.Required {
				return nil, definition, fmt.Errorf("required parameter %s", key)
			}
			continue
		}
		if len(formInput) > 0 && formInput[0] {
			if text, ok := value.(string); ok {
				switch parameter.Type {
				case "boolean":
					if text == "true" {
						value = true
					} else if text == "false" {
						value = false
					}
				case "integer":
					if regexp.MustCompile(`^[0-9]+$`).MatchString(text) {
						if n, parseErr := strconv.ParseFloat(text, 64); parseErr == nil {
							value = n
						}
					}
				case "number":
					if regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`).MatchString(text) {
						if n, parseErr := strconv.ParseFloat(text, 64); parseErr == nil {
							value = n
						}
					}
				}
				if err := setPath(input, key, value); err != nil {
					return nil, definition, err
				}
			}
		}
		if err := validateParameter(key, value, parameter); err != nil {
			return nil, definition, err
		}
	}
	return input, definition, nil
}

func validateParameter(key string, value any, parameter Parameter) error {
	if UnrestrictedValueLimits(parameter) {
		parameter = withoutValueLimits(parameter)
	}
	if value == nil && parameter.Definition["nullable"] == true {
		return nil
	}
	valid := true
	switch parameter.Type {
	case "":
	case "null":
		valid = value == nil
	case "string":
		_, valid = value.(string)
	case "boolean":
		_, valid = value.(bool)
	case "number", "integer":
		n, ok := value.(float64)
		valid = ok
		if ok {
			valid = !math.IsNaN(n) && !math.IsInf(n, 0)
			if parameter.Type == "integer" {
				valid = valid && n == math.Trunc(n) && math.Abs(n) <= 9007199254740991
			}
			if parameter.Minimum != nil {
				valid = valid && n >= *parameter.Minimum
			}
			if parameter.Maximum != nil {
				valid = valid && n <= *parameter.Maximum
			}
		}
	case "array":
		_, valid = value.([]any)
	case "object":
		_, valid = value.(map[string]any)
	default:
		return fmt.Errorf("unsupported parameter type for %s", key)
	}
	if !valid {
		return fmt.Errorf("invalid value for parameter %s", key)
	}
	if len(parameter.Enum) > 0 {
		raw, _ := common.Marshal(value)
		found := false
		for _, allowed := range parameter.Enum {
			encoded, _ := common.Marshal(allowed)
			if string(raw) == string(encoded) {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("invalid option for parameter %s", key)
		}
	}
	return validateSchemaRules(key, value, parameter.Definition, 0)
}
func cloneMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	raw, _ := common.Marshal(value)
	var result map[string]any
	_ = common.Unmarshal(raw, &result)
	return result
}
func merge(base, patch map[string]any) map[string]any {
	result := cloneMap(base)
	for key, value := range cloneMap(patch) {
		nested, ok := value.(map[string]any)
		old, exists := result[key].(map[string]any)
		if ok && exists {
			result[key] = merge(old, nested)
		} else {
			result[key] = value
		}
	}
	return result
}

// Mappings are simultaneous: sources and conflicts are read from the immutable
// original input. A chain never consumes another mapping's newly written value.
func applyMapping(input map[string]any, mapping map[string]string) (map[string]any, error) {
	keys := make([]string, 0, len(mapping))
	for from := range mapping {
		keys = append(keys, from)
	}
	sort.Strings(keys)
	writes := map[string]any{}
	removals := []string{}
	for _, from := range keys {
		to := mapping[from]
		if !validPath(from) {
			return nil, errors.New("invalid parameter mapping source")
		}
		if to != "@ignore" && to != "@reject" && !validPath(to) {
			return nil, errors.New("invalid parameter mapping target")
		}
		value, present := getPath(input, from)
		if !present {
			continue
		}
		if to == "@reject" {
			return nil, fmt.Errorf("unsupported parameter %s", from)
		}
		if to == "@ignore" {
			removals = append(removals, from)
			continue
		}
		if to == from {
			continue
		}
		for path, existing := range writes {
			if path == to && !reflect.DeepEqual(existing, value) {
				return nil, fmt.Errorf("conflicting parameter mapping %s", from)
			}
			if path != to && (strings.HasPrefix(path, to+".") || strings.HasPrefix(to, path+".")) {
				return nil, errors.New("overlapping parameter mapping targets")
			}
		}
		if existing, ok := getPath(input, to); ok && !reflect.DeepEqual(existing, value) {
			return nil, fmt.Errorf("conflicting parameter mapping %s", from)
		}
		writes[to] = value
		removals = append(removals, from)
	}
	result := cloneMap(input)
	for _, path := range removals {
		deletePath(result, path)
	}
	targets := make([]string, 0, len(writes))
	for path := range writes {
		targets = append(targets, path)
	}
	sort.Strings(targets)
	for _, path := range targets {
		if err := setPath(result, path, writes[path]); err != nil {
			return nil, err
		}
	}
	return result, nil
}
func validPath(path string) bool {
	if !namePattern.MatchString(path) {
		return false
	}
	for _, part := range strings.Split(path, ".") {
		if part == "" || blocked.MatchString(part) {
			return false
		}
	}
	return true
}
func getPath(input map[string]any, path string) (any, bool) {
	parts := strings.Split(path, ".")
	current := input
	for i, part := range parts {
		value, ok := current[part]
		if !ok {
			return nil, false
		}
		if i == len(parts)-1 {
			return value, true
		}
		current, ok = value.(map[string]any)
		if !ok {
			return nil, false
		}
	}
	return nil, false
}
func deletePath(input map[string]any, path string) {
	parts := strings.Split(path, ".")
	current := input
	for _, part := range parts[:len(parts)-1] {
		next, ok := current[part].(map[string]any)
		if !ok {
			return
		}
		current = next
	}
	delete(current, parts[len(parts)-1])
}
func setPath(input map[string]any, path string, value any) error {
	parts := strings.Split(path, ".")
	current := input
	for _, part := range parts[:len(parts)-1] {
		next, ok := current[part].(map[string]any)
		if !ok {
			if _, exists := current[part]; exists {
				return errors.New("parameter mapping crosses a non-object value")
			}
			next = map[string]any{}
			current[part] = next
		}
		current = next
	}
	current[parts[len(parts)-1]] = value
	return nil
}

func validateSchemaRules(key string, value any, schema map[string]any, depth int) error {
	if depth > 20 {
		return errors.New("parameter schema is too deeply nested")
	}
	invalid := func() error { return fmt.Errorf("invalid value for parameter %s", key) }
	number := func(name string) (float64, bool) { v, ok := schema[name].(float64); return v, ok }
	switch v := value.(type) {
	case string:
		length := float64(utf8.RuneCountInString(v))
		if n, ok := number("minLength"); ok && length < n {
			return invalid()
		}
		if n, ok := number("maxLength"); ok && length > n {
			return invalid()
		}
		if pattern, ok := schema["pattern"].(string); ok {
			re, err := regexp.Compile(pattern)
			if err != nil {
				return fmt.Errorf("unsupported parameter pattern for %s", key)
			}
			if !re.MatchString(v) {
				return invalid()
			}
		}
	case []any:
		if n, ok := number("minItems"); ok && float64(len(v)) < n {
			return invalid()
		}
		if n, ok := number("maxItems"); ok && float64(len(v)) > n {
			return invalid()
		}
		if schema["uniqueItems"] == true {
			for i, item := range v {
				for _, other := range v[:i] {
					if reflect.DeepEqual(item, other) {
						return invalid()
					}
				}
			}
		}
		if itemSchema, ok := schema["items"].(map[string]any); ok {
			for _, item := range v {
				if err := validateNestedSchema(key, item, itemSchema, depth+1); err != nil {
					return err
				}
			}
		}
	case map[string]any:
		if required, ok := schema["required"].([]any); ok {
			for _, raw := range required {
				field, ok := raw.(string)
				if !ok {
					return invalid()
				}
				if _, present := v[field]; !present {
					return invalid()
				}
			}
		}
		properties, _ := schema["properties"].(map[string]any)
		for name, item := range v {
			if sub, ok := properties[name].(map[string]any); ok {
				if err := validateNestedSchema(key+"."+name, item, sub, depth+1); err != nil {
					return err
				}
			} else {
				if schema["additionalProperties"] == false {
					return invalid()
				}
				if sub, ok := schema["additionalProperties"].(map[string]any); ok {
					if err := validateNestedSchema(key+"."+name, item, sub, depth+1); err != nil {
						return err
					}
				}
			}
		}

	}
	if expected, present := schema["const"]; present && !reflect.DeepEqual(value, expected) {
		return invalid()
	}
	for _, keyword := range []string{"allOf", "anyOf", "oneOf"} {
		if raw, present := schema[keyword]; present {
			options, ok := raw.([]any)
			if !ok || len(options) == 0 || len(options) > 32 {
				return fmt.Errorf("invalid parameter schema for %s", key)
			}
			matches := 0
			for _, rawOption := range options {
				option, ok := rawOption.(map[string]any)
				if !ok {
					return invalid()
				}
				if validateNestedSchema(key, value, option, depth+1) == nil {
					matches++
				}
			}
			if keyword == "allOf" && matches != len(options) || keyword == "anyOf" && matches == 0 || keyword == "oneOf" && matches != 1 {
				return invalid()
			}
		}
	}
	for _, keyword := range []string{"$ref", "not", "if", "then", "else", "dependentSchemas", "contains", "prefixItems"} {
		if _, present := schema[keyword]; present {
			return fmt.Errorf("parameter %s contains rules requiring manual verification: %s", key, keyword)
		}
	}
	return nil
}
func validateNestedSchema(key string, value any, schema map[string]any, depth int) error {
	if depth > 20 {
		return errors.New("parameter schema is too deeply nested")
	}
	// Object-schema required is an array of property names; Parameter.Required
	// is a field-level flag. Decode only the common scalar validation keywords.
	scalar := map[string]any{}
	for _, name := range []string{"type", "enum", "minimum", "maximum"} {
		if value, present := schema[name]; present {
			scalar[name] = value
		}
	}
	raw, err := common.Marshal(scalar)
	if err != nil {
		return err
	}
	var parameter Parameter
	if err = common.Unmarshal(raw, &parameter); err != nil {
		return fmt.Errorf("unsupported parameter schema for %s", key)
	}
	parameter.Definition = map[string]any{"nullable": schema["nullable"]}
	if err = validateParameter(key, value, parameter); err != nil {
		return err
	}
	if value == nil && schema["nullable"] == true {
		return nil
	}
	return validateSchemaRules(key, value, schema, depth)
}

func validateCost(value Cost) error {
	if value.Amount != nil && (math.IsNaN(*value.Amount) || math.IsInf(*value.Amount, 0) || *value.Amount < 0) {
		return errors.New("invalid unit cost")
	}
	if value.Confirmed && (value.Amount == nil || value.Currency == "" || value.Unit == "" || value.Source == nil) {
		return errors.New("confirmed cost requires amount, currency, unit and source")
	}
	if value.Confirmed {
		parsed, err := url.Parse(value.Source.URL)
		if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
			return errors.New("confirmed account cost requires a safe HTTPS source")
		}
		for name := range parsed.Query() {
			if blocked.MatchString(name) || strings.EqualFold(name, "key") || strings.EqualFold(name, "token") {
				return errors.New("remove credentials from account cost source")
			}
		}
		switch strings.ToLower(strings.TrimSpace(value.Unit)) {
		case "request", "request_count", "image", "image_count", "second", "seconds":
		default:
			return errors.New("choose request, image or second as the account cost unit")
		}
	}
	return nil
}

func mergeParameters(base, override map[string]Parameter) map[string]Parameter {
	result := map[string]Parameter{}
	for key, value := range base {
		result[key] = value
	}
	for key, value := range override {
		result[key] = value
	}
	return result
}

func validateInputCapabilities(input map[string]any, cap *InputCapabilities) error {
	if cap == nil {
		return nil
	}
	families := map[string][]string{"images": {"images", "image", "image[]", "image_url", "image_urls", "reference_images", "reference_image_urls", "input_reference", "extra_images"}, "videos": {"videos", "video_urls", "reference_videos", "reference_video_urls", "extra_videos"}, "audios": {"audios", "audio_urls", "reference_audios", "reference_audio_urls", "extra_audios", "audio_durations"}}
	allowed := map[string]bool{"images": cap.Images, "videos": cap.Videos, "audios": cap.Audios}
	for family, fields := range families {
		if allowed[family] {
			continue
		}
		for _, field := range fields {
			if _, present := input[field]; present {
				return fmt.Errorf("input capability is disabled: %s", family)
			}
		}
	}
	if !cap.FirstFrame {
		for _, field := range []string{"first_frame", "start_image_url"} {
			if _, present := input[field]; present {
				return errors.New("first frame input is not enabled")
			}
		}
	}
	if !cap.LastFrame {
		for _, field := range []string{"last_frame", "end_image_url"} {
			if _, present := input[field]; present {
				return errors.New("last frame input is not enabled")
			}
		}
		if input["first_last_frame"] == true {
			return errors.New("last frame input is not enabled")
		}
	}
	checkMaterial := func(material map[string]any) error {
		kind, _ := material["type"].(string)
		if enabled, present := allowed[kind+"s"]; present && !enabled {
			return fmt.Errorf("input capability is disabled: %s", kind)
		}
		role, _ := material["role"].(string)
		if !cap.FirstFrame && (role == "first_frame" || role == "start_frame") {
			return errors.New("first frame input is not enabled")
		}
		if !cap.LastFrame && (role == "last_frame" || role == "end_frame") {
			return errors.New("last frame input is not enabled")
		}
		return nil
	}
	for _, field := range []string{"materials", "images", "reference_images"} {
		if values, ok := input[field].([]any); ok {
			for _, value := range values {
				if material, ok := value.(map[string]any); ok {
					if err := checkMaterial(material); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}
