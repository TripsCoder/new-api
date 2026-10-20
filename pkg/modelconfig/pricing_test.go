package modelconfig

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestModePricingSeparatesNativeCostAndCustomerPrice(t *testing.T) {
	price := 2.0
	resolved := ResolvedMode{Revision: 7, Model: "video", Mode: "text_video", Definition: Mode{Cost: Cost{Amount: &price, Unit: "second", Currency: "CNY", Confirmed: true, Source: &Source{URL: "https://account.example.com/pricing"}}, Billing: &Billing{Expression: `u("seconds") * 0.1`, Currency: "USD", Confirmed: true}}}
	require.NoError(t, ValidateBilling(resolved.Definition.Billing))
	snapshot, err := FreezeUpstreamCost(resolved, map[string]any{"seconds": float64(5), "request_count": float64(1)})
	require.NoError(t, err)
	require.Equal(t, 10.0, *snapshot.Estimate)
	require.Equal(t, "CNY", snapshot.Cost.Currency)
	price = 99
	require.Equal(t, 2.0, *snapshot.Cost.Amount, "snapshot must own its copied source rate")
	require.NoError(t, SettleUpstreamCost(snapshot, nil, true))
	require.Nil(t, snapshot.Actual)
	require.Equal(t, "pending_actual_usage", snapshot.Status)
	require.NoError(t, SettleUpstreamCost(snapshot, map[string]any{"seconds": float64(6)}, true))
	require.Equal(t, 12.0, *snapshot.Actual)
	require.NoError(t, SettleUpstreamCost(snapshot, map[string]any{"seconds": float64(99)}, true))
	require.Equal(t, 12.0, *snapshot.Actual, "duplicate completion must not reprice")
}
func TestUnknownAndFailedSupplierCostsAreNotAssumedFree(t *testing.T) {
	unknown, err := FreezeUpstreamCost(ResolvedMode{}, nil)
	require.NoError(t, err)
	require.Nil(t, unknown.Estimate)
	require.Nil(t, unknown.Actual)
	require.Equal(t, "unknown", unknown.Status)
	amount := 3.0
	snapshot, err := FreezeUpstreamCost(ResolvedMode{Definition: Mode{Cost: Cost{Amount: &amount, Unit: "request", Currency: "FIRE", Confirmed: true}}}, map[string]any{"request_count": float64(1)})
	require.NoError(t, err)
	require.NoError(t, SettleUpstreamCost(snapshot, nil, false))
	require.Nil(t, snapshot.Actual)
	require.Equal(t, "pending_bill_verification", snapshot.Status)
	require.Equal(t, 3.0, *snapshot.Estimate)
	require.Error(t, ValidateBilling(&Billing{Expression: "0.1", Currency: "CNY", Confirmed: true}))
	require.Error(t, ValidateBilling(&Billing{Expression: "not valid [", Currency: "USD", Confirmed: true}))
}
func TestCostFormulaFreezesSubmissionTimeFacts(t *testing.T) {
	amount := 1.0
	resolved := ResolvedMode{Definition: Mode{Cost: Cost{Amount: &amount, Unit: "second", Currency: "CNY", Confirmed: true, Expression: `u("submitted_hour_utc8") < 13 ? u("seconds") * 2 : u("seconds") * 3`}}}
	snapshot, err := FreezeUpstreamCost(resolved, map[string]any{"seconds": float64(4), "submitted_hour_utc8": float64(8)})
	require.NoError(t, err)
	require.Equal(t, 8.0, *snapshot.Estimate)
	require.NoError(t, SettleUpstreamCost(snapshot, map[string]any{"seconds": float64(6)}, true))
	require.Equal(t, 12.0, *snapshot.Actual)
}

func TestNativeCostTimeFunctionsUseFrozenSubmissionTimestamp(t *testing.T) {
	amount := 1.0
	resolved := ResolvedMode{PricingTimestamp: 1792022400, Definition: Mode{Cost: Cost{Amount: &amount, Unit: "second", Currency: "CNY", Confirmed: true, Expression: `hour("Asia/Shanghai") < 13 ? u("seconds") * 2 : u("seconds") * 3`}}}
	snapshot, err := FreezeUpstreamCost(resolved, map[string]any{"seconds": float64(4)})
	require.NoError(t, err)
	require.Equal(t, 8.0, *snapshot.Estimate)
	require.NoError(t, SettleUpstreamCost(snapshot, map[string]any{"seconds": float64(6)}, true))
	require.Equal(t, 12.0, *snapshot.Actual)
}
