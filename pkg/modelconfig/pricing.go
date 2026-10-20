package modelconfig

import (
	"errors"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"math"
	"strings"
)

const ContextKeyResolvedMode = "channel_resolved_model_mode"
const ContextKeyUpstreamAttempted = "channel_mode_cost_upstream_attempted"
const ContextKeyPricingTime = "channel_mode_pricing_timestamp"
const ContextKeyUpstreamCost = "channel_upstream_cost_snapshot"

type Billing struct {
	Expression string `json:"expression"`
	Currency   string `json:"currency"`
	Confirmed  bool   `json:"confirmed"`
}
type ResolvedMode struct {
	PricingTimestamp int64  `json:"pricingTimestamp"`
	Revision         int64  `json:"revision"`
	Model            string `json:"model"`
	Mode             string `json:"mode"`
	Definition       Mode   `json:"definition"`
}
type CostSnapshot struct {
	PricingTimestamp int64          `json:"pricingTimestamp"`
	Revision         int64          `json:"revision"`
	Model            string         `json:"model"`
	Mode             string         `json:"mode"`
	Cost             Cost           `json:"cost"`
	UsageFacts       map[string]any `json:"usageFacts,omitempty"`
	Estimate         *float64       `json:"estimate"`
	Actual           *float64       `json:"actual"`
	Status           string         `json:"status"`
}

func ValidateBilling(value *Billing) error {
	if value == nil || !value.Confirmed {
		return nil
	}
	if value.Currency != "USD" || strings.TrimSpace(value.Expression) == "" {
		return errors.New("confirmed selling price requires a USD formula")
	}
	if billingexpr.UsesFixedPricing(value.Expression) {
		return errors.New("fixed pricing is not supported for task usage expressions")
	}
	_, err := billingexpr.CompileFromCache(value.Expression)
	return err
}

// Native supplier currency remains independent from the USD customer quota.
// This is an estimate snapshot, never a second wallet debit or FX conversion.
func FreezeUpstreamCost(value ResolvedMode, facts map[string]any) (*CostSnapshot, error) {
	raw, err := common.Marshal(value.Definition.Cost)
	if err != nil {
		return nil, err
	}
	var frozen Cost
	if err = common.Unmarshal(raw, &frozen); err != nil {
		return nil, err
	}
	snapshot := &CostSnapshot{PricingTimestamp: value.PricingTimestamp, Revision: value.Revision, Model: value.Model, Mode: value.Mode, Cost: frozen, UsageFacts: cloneMap(facts), Status: "unknown"}
	if !snapshot.Cost.Confirmed {
		return snapshot, nil
	}
	amount, err := EvaluateNativeCost(snapshot.Cost, facts, snapshot.PricingTimestamp)
	if err != nil {
		return nil, err
	}
	snapshot.Estimate = &amount
	snapshot.Status = "estimated"
	return snapshot, nil
}
func EvaluateNativeCost(cost Cost, facts map[string]any, timestamp ...int64) (float64, error) {
	at := int64(0)
	if len(timestamp) > 0 {
		at = timestamp[0]
	}
	if !cost.Confirmed || cost.Amount == nil || cost.Currency == "" {
		return 0, errors.New("account cost has not been confirmed")
	}
	var amount float64
	if cost.Expression != "" {
		value, _, err := billingexpr.RunExprWithRequest(cost.Expression, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts, PricingTimestamp: at})
		if err != nil {
			return 0, err
		}
		amount = value
	} else {
		field := ""
		switch strings.ToLower(strings.TrimSpace(cost.Unit)) {
		case "request", "request_count":
			field = "request_count"
		case "image", "image_count":
			field = "image_count"
		case "second", "seconds":
			field = "seconds"
		default:
			return 0, errors.New("choose request, image or second as the account cost unit")
		}
		quantity, ok := facts[field].(float64)
		if !ok || quantity < 0 || math.IsNaN(quantity) || math.IsInf(quantity, 0) {
			return 0, errors.New("account cost usage quantity is unavailable")
		}
		amount = *cost.Amount * quantity
	}
	if amount < 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {
		return 0, errors.New("invalid account cost result")
	}
	return amount, nil
}

// Only provider-validated completion facts can turn an estimate into an actual.
// Missing output-duration facts and uncertain failed-request charges stay pending.
func SettleUpstreamCost(snapshot *CostSnapshot, actual map[string]any, success bool) error {
	if snapshot == nil || snapshot.Actual != nil || !snapshot.Cost.Confirmed {
		return nil
	}
	if !success {
		snapshot.Status = "pending_bill_verification"
		return nil
	}
	facts := merge(snapshot.UsageFacts, actual)
	field := ""
	switch strings.ToLower(strings.TrimSpace(snapshot.Cost.Unit)) {
	case "request", "request_count":
		field = "request_count"
		facts[field] = float64(1)
	case "image", "image_count":
		field = "image_count"
	case "second", "seconds":
		field = "seconds"
	}
	if snapshot.Cost.Expression != "" {
		for key := range billingexpr.UsedUsageKeys(snapshot.Cost.Expression) {
			if key == "submitted_hour_utc8" || key == "request_count" {
				continue
			}
			if _, numeric := snapshot.UsageFacts[key].(float64); numeric {
				if _, available := actual[key]; !available {
					snapshot.Status = "pending_actual_usage"
					return nil
				}
			}
		}
	}
	if field != "request_count" {
		if _, ok := actual[field]; !ok {
			snapshot.Status = "pending_actual_usage"
			return nil
		}
	}
	amount, err := EvaluateNativeCost(snapshot.Cost, facts, snapshot.PricingTimestamp)
	if err != nil {
		return err
	}
	snapshot.Actual = &amount
	snapshot.Status = "settled"
	return nil
}
