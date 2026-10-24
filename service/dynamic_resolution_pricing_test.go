package service

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/stretchr/testify/require"
)

func TestDynamicResolutionPriceEstimateAndSettlement(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", "lxmone_media.plugin.js"))
	require.NoError(t, err)
	plugin, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{Key: "lxmone_media"})
	require.NoError(t, err)
	expression := `lower(string(u("resolution"))) == "768px" ? tier("768px", 0 * u("seconds")) : lower(string(u("resolution"))) == "2k" ? tier("2K", 0.2 * u("seconds")) : lower(string(u("resolution"))) == "4k" ? tier("4K", 0.4 * u("seconds")) : nil`
	require.NoError(t, modelconfig.ValidateBilling(&modelconfig.Billing{Expression: expression, Currency: "USD", Confirmed: true}))
	for _, tc := range []struct {
		resolution string
		rate       float64
	}{{"768px", 0}, {"2K", 0.2}, {"4K", 0.4}, {"4k", 0.4}} {
		t.Run(tc.resolution, func(t *testing.T) {
			ctx := map[string]any{"model": "fresh-video", "upstreamModel": "fresh-video", "requestBody": map[string]any{"operation": "video_generate", "protocolTemplate": "interface:d5712463006900d8", "unrestrictedValueFields": []string{"resolution"}, "input": map[string]any{"model": "fresh-video", "prompt": "offline fixture", "seconds": 6, "resolution": tc.resolution}}}
			var facts map[string]any
			require.NoError(t, plugin.Engine.CallInto(t.Context(), &facts, "extractUsage", ctx))
			cost, _, err := billingexpr.RunExprWithRequest(expression, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
			require.NoError(t, err)
			require.InDelta(t, tc.rate*6, cost, 1e-9)
			snapshot := billingexpr.BillingSnapshot{ExprString: expression, ExprHash: billingexpr.ExprHashString(expression), ExprVersion: 1, TaskUsageBilling: true, UsageFacts: facts, GroupRatio: 1, QuotaPerUnit: common.QuotaPerUnit}
			encoded, err := common.Marshal(snapshot)
			require.NoError(t, err)
			var frozen billingexpr.BillingSnapshot
			require.NoError(t, common.Unmarshal(encoded, &frozen))
			for _, seconds := range []float64{6, 4} {
				result, actual, err := EvaluateTaskCompletionUsage(&frozen, map[string]any{"seconds": seconds})
				require.NoError(t, err)
				require.Equal(t, facts["resolution"], actual["resolution"])
				require.Equal(t, common.QuotaRound(tc.rate*seconds*common.QuotaPerUnit), result.ActualQuotaAfterGroup)
			}
		})
	}
	for _, resolution := range []string{"", "8K"} {
		facts := map[string]any{"seconds": float64(6)}
		if resolution != "" {
			facts["resolution"] = resolution
		}
		_, _, err := billingexpr.RunExprWithRequest(expression, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
		require.Error(t, err)
	}
}
