package jsplugin

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/setting/billing_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFenglangOfficialTokenReservationAndPollingSettlement(t *testing.T) {
	source, err := os.ReadFile("../../../../plugin-sources/fenglang-video/dist/fenglang_video.plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.CompilePlugin(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	var template string
	for id, definition := range plugin.Meta.ParameterInterfaces {
		if definition.(map[string]any)["path"] == "/api/v3/contents/generations/tasks" {
			template = id
		}
	}
	require.NotEmpty(t, template)
	const name = "doubao-seedance-2-5-260628"
	schema, _ := plugin.Meta.UsageForModels(name)
	assert.Contains(t, schema, "tokens")
	assert.NotContains(t, schema, "seconds")
	const expression = `tier("fixture", u("tokens") * 2 / 1000000)`
	require.True(t, billing_setting.TaskExprCompatible(expression, schema))
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", nil)
	c.Set("task_request", map[string]any{"operation": "video_generate", "protocolTemplate": template, "input": map[string]any{"prompt": "Fixture", "seconds": 4, "resolution": "720p"}})
	info := &relaycommon.RelayInfo{OriginModelName: name, ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: name, ChannelBaseUrl: "https://supplier.example/open/v1", ApiKey: "fixture-only"}, TaskRelayInfo: &relaycommon.TaskRelayInfo{}}
	adaptor := New(plugin)
	adaptor.Init(info)
	require.Nil(t, adaptor.ValidateRequestAndSetAction(c, info))
	facts, err := adaptor.ExtractUsageFactsValidated(c, info)
	require.NoError(t, err)
	assert.Equal(t, float64(86400), facts["tokens"])
	state, err := common.Marshal(map[string]string{"protocolTemplate": template})
	require.NoError(t, err)
	task := &model.Task{TaskID: "task_fixture", Properties: model.Properties{OriginModelName: name, UpstreamModelName: name}, PrivateData: model.TaskPrivateData{UpstreamTaskID: "private_fixture", PluginState: state}}
	result, err := adaptor.ParseTaskResult(task, &http.Response{StatusCode: http.StatusOK, Header: make(http.Header)}, []byte(`{"status":"succeeded","content":{"video_url":"https://media.example/video.mp4"},"usage":{"total_tokens":1000,"completion_tokens":900}}`))
	require.NoError(t, err)
	assert.Equal(t, "SUCCESS", result.Status)
	assert.Equal(t, float64(1000), result.UsageFacts["tokens"])
	for key, value := range result.UsageFacts {
		facts[key] = value
	}
	assert.Equal(t, "720p", facts["resolution"])
	assert.Equal(t, "none", facts["video_input"])
	cost, _, err := billingexpr.RunExprWithRequest(expression, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
	require.NoError(t, err)
	assert.InDelta(t, .002, cost, 1e-12)
}

func TestFenglangResolutionUsageRunsSavedTieredExpression(t *testing.T) {
	source, err := os.ReadFile("../../../../plugin-sources/fenglang-video/dist/fenglang_video.plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.CompilePlugin(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	const expression = `lower(string(u("resolution"))) == "480p" ? tier("480p", 0.145 * u("seconds")) : lower(string(u("resolution"))) == "720p" ? tier("720p", 0.187 * u("seconds")) : nil`
	schema, _ := plugin.Meta.UsageForModels("seedance-2.0-mini")
	require.True(t, billing_setting.TaskExprCompatible(expression, schema))
	var template string
	for key, definition := range plugin.Meta.ParameterInterfaces {
		if definition.(map[string]any)["path"] == "/open/v1/videos" {
			template = key
		}
	}
	require.NotEmpty(t, template)
	for _, tc := range []struct {
		resolution string
		seconds    int
		unit       float64
	}{{"480p", 4, .145}, {"720p", 4, .187}, {"480p", 15, .145}, {"720p", 15, .187}} {
		t.Run(tc.resolution+" duration", func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", nil)
			c.Set("task_request", map[string]any{"operation": "video_generate", "protocolTemplate": template, "input": map[string]any{"prompt": "Fixture", "seconds": tc.seconds, "resolution": tc.resolution}})
			info := &relaycommon.RelayInfo{OriginModelName: "seedance-2.0-mini", ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "seedance-2.0-mini", ChannelBaseUrl: "https://supplier.example/open/v1", ApiKey: "fixture-only"}, TaskRelayInfo: &relaycommon.TaskRelayInfo{}}
			adaptor := New(plugin)
			adaptor.Init(info)
			require.Nil(t, adaptor.ValidateRequestAndSetAction(c, info))
			facts, err := adaptor.ExtractUsageFactsValidated(c, info)
			require.NoError(t, err)
			require.Equal(t, tc.resolution, facts["resolution"])
			require.Equal(t, float64(tc.seconds), facts["seconds"])
			require.Equal(t, float64(1), facts["request_count"])
			cost, trace, err := billingexpr.RunExprWithRequest(expression, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
			require.NoError(t, err)
			require.InDelta(t, tc.unit*float64(tc.seconds), cost, 1e-12)
			require.Equal(t, tc.resolution, trace.MatchedTier)
			// Reproduce the old hook's missing dimension: it must fail, never bill zero.
			delete(facts, "resolution")
			_, _, err = billingexpr.RunExprWithRequest(expression, billingexpr.TokenParams{}, billingexpr.RequestInput{Usage: facts})
			require.Error(t, err)
		})
	}
}
