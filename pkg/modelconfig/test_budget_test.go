package modelconfig

import (
	"github.com/stretchr/testify/require"
	"math"
	"testing"
)

func TestRealCallEstimateBudgetFailsBeforeBilling(t *testing.T) {
	amount := 2.0
	cost := &CostSnapshot{Estimate: &amount}
	budget := TestCallBudget{MaxEstimatedUSD: 0.1, AcceptCharge: true}
	require.NoError(t, budget.Check(0.09, cost))
	require.Error(t, budget.Check(0.11, cost))
	require.Error(t, budget.Check(0.09, nil))
	budget.AcceptUnknownProviderCost = true
	require.NoError(t, budget.Check(0.09, nil))
	for _, value := range []float64{math.NaN(), math.Inf(1), -1} {
		require.Error(t, budget.Check(value, cost))
	}
	budget.AcceptCharge = false
	require.Error(t, budget.Check(0.01, cost))
	budget.AcceptCharge = true
	budget.MaxEstimatedUSD = 0
	require.Error(t, budget.Check(0, cost))
}
