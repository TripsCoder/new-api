package jsplugin

import (
	"errors"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"maps"
	"strings"
)

const channelConfigurationPinKey = "channel_model_configuration_pin"

type requestConfigurationPin struct {
	// Keep the input of the most recent overlay so it can be undone before
	// the next final decoder. Each channel revision remains pinned separately.
	Original  map[string]any
	Documents map[int]*modelconfig.Document
	Applied   bool
}

func copyNormalizedRequest(value any) (map[string]any, error) {
	raw, err := common.Marshal(jsonValue(value))
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err = common.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	if result == nil {
		return nil, errors.New("invalid normalized task request")
	}
	return result, nil
}
func (a *TaskAdaptor) applyChannelModelConfiguration(c *gin.Context, info *relaycommon.RelayInfo) error {
	if !modelconfig.SupportedProvider(a.plugin.Meta.Key) || info.ChannelId <= 0 {
		return nil
	}
	// This member is host-owned. A legacy caller must not inject it, even
	// when the channel has no saved configuration.
	if raw, exists := c.Get("task_request"); exists {
		if body, ok := raw.(map[string]any); ok {
			body = maps.Clone(body)
			delete(body, "protocolTemplate")
			delete(body, "manualInterfaceFields")
			c.Set("task_request", body)
		}
	}
	var pin *requestConfigurationPin
	if value, exists := c.Get(channelConfigurationPinKey); exists {
		var ok bool
		pin, ok = value.(*requestConfigurationPin)
		if !ok || pin == nil {
			return errors.New("invalid channel configuration pin")
		}
	} else {
		pin = &requestConfigurationPin{Documents: map[int]*modelconfig.Document{}}
		c.Set(channelConfigurationPinKey, pin)
	}
	document, seen := pin.Documents[info.ChannelId]
	if !seen {
		if model.DB == nil {
			return nil
		}
		loaded, err := model.GetChannelModelConfiguration(c.Request.Context(), info.ChannelId, 0)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			pin.Documents[info.ChannelId] = nil
			return nil
		}
		if err != nil {
			return err
		}
		document = &loaded
		pin.Documents[info.ChannelId] = document
	}
	// No configuration means no request conversion/copying. This matters for
	// ordinary image calls carrying large data URLs or multipart file references.
	if document == nil {
		return nil
	}
	if document.Provider != a.plugin.Meta.Key {
		return errors.New("channel configuration provider does not match the selected plugin")
	}
	raw, present := c.Get("task_request")
	if !present {
		return errors.New("normalized task request is missing")
	}
	normalized, ok := raw.(map[string]any)
	if !ok {
		var err error
		normalized, err = copyNormalizedRequest(raw)
		if err != nil {
			return err
		}
	}
	input, ok := normalized["input"].(map[string]any)
	if !ok {
		return errors.New("normalized input is missing")
	}
	operation, _ := normalized["operation"].(string)
	selected := info.OriginModelName
	if _, exists := document.Bindings[selected]; !exists {
		selected = info.UpstreamModelName
	}
	if _, exists := document.Bindings[selected]; !exists {
		canonical := modelconfig.CanonicalReviewedModelName(document.Provider, info.UpstreamModelName)
		for candidate := range document.Bindings {
			if modelconfig.CanonicalReviewedModelName(document.Provider, candidate) == canonical {
				selected = candidate
				break
			}
		}
	}
	// Manual contracts can be staged while a legacy version remains active.
	// They must not change or disable its existing request/price behavior.
	if !modelconfig.ReviewedPluginVersion(a.plugin.Meta.Version) {
		for mode, binding := range document.Bindings[selected] {
			if binding.Protocol != nil || document.Groups[binding.GroupID].Modes[mode].Protocol != nil {
				return nil
			}
		}
	}
	contractMode, _ := normalized["contractMode"].(string)
	effective, definition, mode, unified, err := modelconfig.ResolveUnified(*document, selected, operation, input, strings.HasPrefix(c.ContentType(), "multipart/") || c.ContentType() == "application/x-www-form-urlencoded")
	if !unified && err == nil {
		mode, err = modelconfig.InferConfiguredMode(*document, selected, operation, input, normalized["uploads"], contractMode)
	}
	if err != nil {
		return err
	}
	// Saved configurations are partial overlays. Only explicitly edited bindings
	// are affected; an explicitly disabled binding is rejected by Resolve.
	if _, exists := document.Bindings[selected][mode]; !unified && !exists {
		return nil
	}
	if a.plugin.Meta.PreservesJSONOrder() {
		return errors.New("channel configuration is not supported by JSON-order-preserving task plugins")
	}
	if !unified {
		effective, definition, err = modelconfig.Resolve(*document, selected, mode, input, strings.HasPrefix(c.ContentType(), "multipart/") || c.ContentType() == "application/x-www-form-urlencoded")
	}
	if err != nil {
		return err
	}
	if hint := modelconfig.ProtocolContractHint(document.Provider, definition.Protocol); hint != "" {
		contractMode = hint
	}
	if !unified && modelconfig.InferContractMode(operation, effective, normalized["uploads"], contractMode) != mode {
		return errors.New("configuration changes the generation mode; configure the actual reference mode explicitly")
	}
	// Resolve clones input. The wrapper is shallow-copied, leaving the original
	// decoded request and opaque uploads untouched for the relay's next decoder.
	body := maps.Clone(normalized)
	body["contractMode"] = contractMode
	body["input"] = effective
	// This control metadata comes only from the resolved saved configuration.
	// Never trust a similarly named field supplied by the API client.
	delete(body, "unrestrictedValueFields")
	unrestricted := []string{}
	for field, parameter := range definition.Parameters {
		if modelconfig.UnrestrictedValueLimits(parameter) {
			unrestricted = append(unrestricted, field)
		}
	}
	if len(unrestricted) > 0 {
		body["unrestrictedValueFields"] = unrestricted
	}

	delete(body, "protocolTemplate")
	delete(body, "manualInterfaceFields")
	if definition.Protocol != nil {
		if !modelconfig.ReviewedPluginVersion(a.plugin.Meta.Version) {
			return errors.New("manual protocol binding requires the reviewed version 2 plugin")
		}
		if err := modelconfig.ValidateProtocolBinding(document.Provider, mode, definition.Protocol); err != nil {
			return err
		}
		body["protocolTemplate"] = definition.Protocol.TemplateModel
		if fields := modelconfig.ManualInterfaceFields(definition.Protocol); len(fields) > 0 {
			body["manualInterfaceFields"] = fields
		}
	}
	pin.Original = normalized
	pin.Applied = true
	c.Set("task_request", body)
	c.Set(modelconfig.ContextKeyPricingTime, a.submissionTime)
	c.Set(modelconfig.ContextKeyRevision, document.Revision)
	c.Set(modelconfig.ContextKeyResolvedMode, modelconfig.ResolvedMode{PricingTimestamp: a.submissionTime, Revision: document.Revision, Model: selected, Mode: mode, Definition: definition})
	return nil
}

// Undo only our previous overlay before the next final plugin decoder runs.
// A new decoder's private request must never be replaced afterwards.
func restoreChannelConfigurationInput(c *gin.Context) error {
	value, exists := c.Get(channelConfigurationPinKey)
	if !exists {
		return nil
	}
	pin, ok := value.(*requestConfigurationPin)
	if !ok || pin == nil {
		return errors.New("invalid channel configuration pin")
	}
	if !pin.Applied {
		return nil
	}
	c.Set("task_request", pin.Original)
	c.Set(modelconfig.ContextKeyRevision, int64(0))
	c.Set(modelconfig.ContextKeyPricingTime, int64(0))
	c.Set(modelconfig.ContextKeyResolvedMode, nil)
	c.Set(modelconfig.ContextKeyUpstreamCost, nil)
	pin.Applied = false
	return nil
}

// PinChannelModelConfiguration freezes a validated saved configuration for an
// administrative real test before normal relay validation and billing begin.
func PinChannelModelConfiguration(c *gin.Context, channelID int, document modelconfig.Document) error {
	if c == nil || channelID <= 0 || document.Revision <= 0 {
		return errors.New("invalid saved configuration pin")
	}
	if err := modelconfig.Validate(document); err != nil {
		return err
	}
	raw, err := common.Marshal(document)
	if err != nil {
		return err
	}
	var frozen modelconfig.Document
	if err = common.Unmarshal(raw, &frozen); err != nil {
		return err
	}
	c.Set(channelConfigurationPinKey, &requestConfigurationPin{Documents: map[int]*modelconfig.Document{channelID: &frozen}})
	return nil
}
