package jsplugin

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/plugins"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDoubaoAudioHookFixturesAndFrozenMinutePrice(t *testing.T) {
	source, err := plugins.Source("doubao-audio")
	require.NoError(t, err)
	fixture, err := os.ReadFile("../../../../plugin-sources/doubao-audio/fixtures/hooks.json")
	require.NoError(t, err)
	report, err := pluginruntime.ReplayFixture(t.Context(), source, fixture)
	require.NoError(t, err)
	assert.Equal(t, report.Total, report.Passed)
	assert.Greater(t, report.Passed, 35)
	// Official price: 1 CNY/minute. Administrator requested numeric 1:1;
	// this fixture checks their expression, not a built-in USD default.
	const expression = `tier("audio", u("seconds") * 0.016666666666666666)`
	snapshot := &billingexpr.BillingSnapshot{ExprString: expression, ExprHash: billingexpr.ExprHashString(expression), GroupRatio: 1, QuotaPerUnit: 500000, ExprVersion: 1, TaskUsageBilling: true, UsageFacts: map[string]any{"seconds": float64(120)}, EstimatedQuotaAfterGroup: 1000000}
	for _, seconds := range []float64{10.25, 60, 120} {
		settled, usage, err := service.EvaluateTaskCompletionUsage(snapshot, map[string]any{"seconds": seconds})
		require.NoError(t, err)
		assert.Equal(t, seconds, usage["seconds"])
		assert.Equal(t, common.QuotaRound(seconds/60*500000), settled.ActualQuotaAfterGroup)
		assert.Equal(t, float64(120), snapshot.UsageFacts["seconds"], "completion must not overwrite frozen reservation")
	}
}

func TestDoubaoAudioImmediateUsageAndLargeResponse(t *testing.T) {
	source, err := plugins.Source("doubao-audio")
	require.NoError(t, err)
	plugin, err := pluginruntime.CompilePlugin(source, pluginruntime.Options{})
	require.NoError(t, err)
	info := &relaycommon.RelayInfo{OriginModelName: "audio-alias", ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "seed-audio-1.0", ChannelBaseUrl: "https://openspeech.bytedance.com", ApiKey: "fixture-key"}, TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_audio"}}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/doubao/audio/generations", nil)
	c.Set("task_request", map[string]any{"model": "audio-alias", "text_prompt": "生成十秒音效", "audio_config": map[string]any{"format": "mp3", "pitch_rate": 0, "enable_subtitle": false}})
	adaptor := New(plugin)
	adaptor.Init(info)
	require.Nil(t, adaptor.ValidateRequestAndSetAction(c, info))
	facts, err := adaptor.ExtractUsageFactsValidated(c, info)
	require.NoError(t, err)
	assert.Equal(t, float64(120), facts["seconds"])
	assert.Equal(t, "seed-audio-1.0", adaptor.submit.Body.(map[string]any)["model"])
	assert.Equal(t, "fixture-key", adaptor.submit.Headers["X-Api-Key"])
	assert.NotContains(t, adaptor.submit.Headers, "Authorization")
	assert.Equal(t, "audio-alias", info.OriginModelName)
	for _, tc := range []struct {
		name    string
		seconds any
		valid   bool
	}{
		{"measured original duration", 10.25, true}, {"maximum", 120, true},
		{"missing", nil, false}, {"negative", -1, false}, {"zero", 0, false},
		{"over maximum", 121, false}, {"string cannot bill", "10", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := common.Marshal(map[string]any{"audio": strings.Repeat("A", 2<<20), "url": "https://cdn.example/audio.mp3", "duration": 5.125, "original_duration": tc.seconds})
			require.NoError(t, err)
			resp := &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}
			parsed, taskErr := adaptor.ParseResponse(c, resp, info)
			if !tc.valid {
				require.NotNil(t, taskErr)
				assert.True(t, taskErr.NoRetry)
				return
			}
			require.Nil(t, taskErr)
			require.NotNil(t, parsed.Immediate)
			assert.Equal(t, "SUCCESS", parsed.Immediate.Status)
			assert.Less(t, len(parsed.TaskData), 1024)
			assert.NotContains(t, string(parsed.TaskData), `"audio":`)
			var data map[string]any
			require.NoError(t, common.Unmarshal(parsed.TaskData, &data))
			assert.Equal(t, data["original_duration"], parsed.Immediate.UsageFacts["seconds"])
			assert.NotEqual(t, data["duration"], parsed.Immediate.UsageFacts["seconds"])
		})
	}
}

func TestTaskSubmitJSONBoundsAndNoDuplicateRetry(t *testing.T) {
	for _, tc := range []struct {
		name          string
		capability    bool
		oversizedData bool
		bodySize      int
		want          string
	}{
		{"ordinary limit preserved", false, false, (1 << 20) + 1, "exceeds size limit"},
		{"large transport bounded", true, false, (64 << 20) + 1, "exceeds size limit"},
		{"persisted data still bounded", true, true, 2 << 20, "task data exceeds size limit"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := mockPlugin
			if tc.capability {
				source = strings.Replace(source, "apiVersion: 1,", `apiVersion: 1, requiredCapabilities: ["large-submit-json@1"],`, 1)
			}
			if tc.oversizedData {
				source = strings.Replace(source, "taskData: {accepted: true, status: resp.statusCode}", "taskData: resp.body", 1)
			}
			plugin, err := pluginruntime.CompilePlugin(source, pluginruntime.Options{})
			require.NoError(t, err)
			adaptor := New(plugin)
			info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{}, TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_public"}}
			adaptor.Init(info)
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/submit", nil)
			body := `{"id":"upstream","audio":"` + strings.Repeat("A", tc.bodySize) + `"}`
			_, taskErr := adaptor.ParseResponse(c, &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, info)
			require.NotNil(t, taskErr)
			assert.ErrorContains(t, taskErr.Error, tc.want)
			assert.True(t, taskErr.NoRetry)
		})
	}
}
