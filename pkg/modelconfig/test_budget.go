package modelconfig

import (
	"errors"
	"math"
)

const ContextKeyTestBudget = "channel_configuration_test_budget"

// TestCallBudget limits the submit-time estimate. Provider output usage can
// settle differently, so it is deliberately not advertised as a final bill cap.
type TestCallBudget struct {
	MaxEstimatedUSD           float64 `json:"maxEstimatedUSD"`
	AcceptCharge              bool    `json:"acceptCharge"`
	AcceptUnknownProviderCost bool    `json:"acceptUnknownProviderCost"`
}

func (b TestCallBudget) Validate() error {
	if !b.AcceptCharge || b.MaxEstimatedUSD <= 0 || math.IsNaN(b.MaxEstimatedUSD) || math.IsInf(b.MaxEstimatedUSD, 0) {
		return errors.New("confirm the real call charge and enter a positive USD estimate limit")
	}
	return nil
}
func (b TestCallBudget) Check(estimatedUSD float64, cost *CostSnapshot) error {
	if err := b.Validate(); err != nil {
		return err
	}
	if estimatedUSD < 0 || math.IsNaN(estimatedUSD) || math.IsInf(estimatedUSD, 0) || estimatedUSD > b.MaxEstimatedUSD {
		return errors.New("the estimated customer charge exceeds the real call limit")
	}
	if (cost == nil || cost.Estimate == nil) && !b.AcceptUnknownProviderCost {
		return errors.New("the provider cost is unknown; acknowledge it before a real call")
	}
	return nil
}
