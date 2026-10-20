package billingexpr

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestSettlementUsesFrozenPricingTimeInsteadOfLaterRequestTime(t *testing.T) {
	expression := `hour("UTC") * 0.01`
	frozen := int64(1792051200)
	estimate, _, err := RunExprWithRequest(expression, TokenParams{}, RequestInput{PricingTimestamp: frozen})
	require.NoError(t, err)
	snapshot := &BillingSnapshot{PricingTimestamp: frozen, ExprString: expression, ExprHash: ExprHashString(expression), GroupRatio: 1, QuotaPerUnit: 100, TaskUsageBilling: true}
	result, err := ComputeTieredQuotaWithRequest(snapshot, TokenParams{}, RequestInput{PricingTimestamp: frozen + 12*3600})
	require.NoError(t, err)
	require.InDelta(t, estimate*100, result.ActualQuotaBeforeGroup, 0.000001)
	snapshot.PricingTimestamp = 0
	legacy, err := ComputeTieredQuotaWithRequest(snapshot, TokenParams{}, RequestInput{PricingTimestamp: frozen + 12*3600})
	require.NoError(t, err)
	require.NotEqual(t, result.ActualQuotaAfterGroup, legacy.ActualQuotaAfterGroup)
}
