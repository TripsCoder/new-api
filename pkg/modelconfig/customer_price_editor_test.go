package modelconfig

import (
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestCustomerPriceEditorExpressions(t *testing.T) {
	for _, tc := range []struct {
		expression, fact   string
		quantity, expected float64
	}{
		{`0.25 * u("request_count")`, "request_count", 1, 0.25},
		{`0.25 * u("seconds")`, "seconds", 6, 1.5},
		{`0.25 * u("image_count")`, "image_count", 4, 1},
	} {
		t.Run(tc.fact, func(t *testing.T) {
			require.NoError(t, ValidateBilling(&Billing{Expression: tc.expression, Currency: "USD", Confirmed: true}))
			amount, _, err := billingexpr.RunExprWithRequest(tc.expression, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: map[string]any{tc.fact: tc.quantity}})
			require.NoError(t, err)
			require.InDelta(t, tc.expected, amount, 1e-9)
		})
	}
}

func TestResolutionPricesWithoutBaseRejectUnpricedUsage(t *testing.T) {
	expression := `u("resolution") == "720p" ? tier("720p", 0.21 * u("seconds")) : u("resolution") == "1080p" ? tier("1080p", 0.27 * u("seconds")) : nil`
	require.NoError(t, ValidateBilling(&Billing{Expression: expression, Currency: "USD", Confirmed: true}))
	for _, tc := range []struct {
		resolution string
		price      float64
	}{{"720p", 0.21}, {"1080p", 0.27}, {"", -1}, {"480p", -1}, {"4k", -1}} {
		t.Run(tc.resolution, func(t *testing.T) {
			facts := map[string]any{"seconds": 6.0}
			if tc.resolution != "" {
				facts["resolution"] = tc.resolution
			}
			cost, trace, err := billingexpr.RunExprWithRequest(expression, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
			if tc.price < 0 {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.InDelta(t, 6*tc.price, cost, 1e-9)
			assert.Equal(t, tc.resolution, trace.MatchedTier)
			// Completion reevaluates the frozen expression at measured duration.
			facts["seconds"] = 4.0
			snapshot := &billingexpr.BillingSnapshot{ExprString: expression, ExprHash: billingexpr.ExprHashString(expression), TaskUsageBilling: true, GroupRatio: 1, QuotaPerUnit: 500000}
			settled, err := billingexpr.ComputeTieredQuotaWithRequest(snapshot, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
			require.NoError(t, err)
			assert.Equal(t, int(4*tc.price*500000), settled.ActualQuotaAfterGroup)
		})
	}
}
