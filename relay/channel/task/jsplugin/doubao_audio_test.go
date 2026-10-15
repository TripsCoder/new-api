package jsplugin

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/iotest"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/plugins"
	"github.com/QuantumNous/new-api/relay/channel"
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
	info := &relaycommon.RelayInfo{OriginModelName: "audio-alias", ChannelMeta: &relaycommon.ChannelMeta{ChannelType: constant.ChannelTypeTaskPlugin, UpstreamModelName: "seed-audio-1.0", ChannelBaseUrl: "https://openspeech.bytedance.com", ApiKey: "fixture-key"}, TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_audio"}}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/doubao/audio/generations", nil)
	c.Request.Header.Set("Authorization", "Bearer client-fixture-token")
	c.Request.Header.Set("X-New-Api-Channel-Id", "14")
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
	upstreamRequest := httptest.NewRequest(http.MethodPost, adaptor.submit.URL, nil)
	require.NoError(t, adaptor.BuildRequestHeader(c, upstreamRequest, info))
	assert.Equal(t, "fixture-key", upstreamRequest.Header.Get("X-Api-Key"))
	assert.Empty(t, upstreamRequest.Header.Get("Authorization"), "the client token is not a supplier credential")
	assert.Empty(t, upstreamRequest.Header.Get("X-New-Api-Channel-Id"), "the gateway selector is not a supplier parameter")
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
			task := &model.Task{TaskID: "task_audio", Status: model.TaskStatusSuccess, Data: parsed.TaskData}
			artifacts, err := adaptor.ListArtifacts(task)
			require.NoError(t, err)
			require.Len(t, artifacts, 1)
			assert.Equal(t, "audio", artifacts[0].Key)
			assert.Equal(t, "audio", artifacts[0].Type)
			assert.Equal(t, "audio/mpeg", artifacts[0].MimeType)
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				content, err := adaptor.BuildContentRequest(t.Context(), task, "audio", channel.TaskArtifactClientRequest{Method: method})
				require.NoError(t, err)
				require.NotNil(t, content)
				assert.Equal(t, "https://cdn.example/audio.mp3", content.URL)
				assert.Equal(t, method, content.Method)
				assert.True(t, content.Credentialless)
				assert.Empty(t, content.Headers)
				assert.Empty(t, content.Body)
			}
			data["expires_at"] = 0
			task.Data, err = common.Marshal(data)
			require.NoError(t, err)
			_, err = adaptor.BuildContentRequest(t.Context(), task, "audio", channel.TaskArtifactClientRequest{Method: http.MethodGet})
			require.ErrorContains(t, err, "expired")
		})
	}
}

func TestDoubaoAudioAcceptedResponseFailureDoesNotRetry(t *testing.T) {
	source, err := plugins.Source("doubao-audio")
	require.NoError(t, err)
	for _, withCapability := range []bool{true, false} {
		name := "large response capability"
		pluginSource := source
		if !withCapability {
			name = "ordinary JSON behavior"
			pluginSource = strings.Replace(source, `requiredCapabilities: ["large-submit-json@1"],`, "", 1)
		}
		t.Run(name, func(t *testing.T) {
			plugin, err := pluginruntime.CompilePlugin(pluginSource, pluginruntime.Options{})
			require.NoError(t, err)
			adaptor := New(plugin)
			info := &relaycommon.RelayInfo{OriginModelName: "seed-audio-1.0", ChannelMeta: &relaycommon.ChannelMeta{ChannelType: constant.ChannelTypeTaskPlugin}, TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_audio"}}
			adaptor.Init(info)
			for _, tc := range []struct {
				name        string
				status      int
				body        string
				readFailure bool
			}{
				{"malformed JSON", http.StatusOK, `{"audio":`, false},
				{"response read failure", http.StatusOK, "", true},
				{"unexpected accepted response", http.StatusAccepted, `{}`, false},
				{"provider error after HTTP success", http.StatusOK, `{"code":45000000}`, false},
				{"invalid result URL", http.StatusOK, `{"original_duration":10,"duration":10,"url":"http://cdn.example/audio.mp3"}`, false},
			} {
				t.Run(tc.name, func(t *testing.T) {
					c, _ := gin.CreateTestContext(httptest.NewRecorder())
					c.Request = httptest.NewRequest(http.MethodPost, "/doubao/audio/generations", nil)
					var body io.Reader = strings.NewReader(tc.body)
					if tc.readFailure {
						body = iotest.ErrReader(io.ErrUnexpectedEOF)
					}
					response := &http.Response{StatusCode: tc.status, Header: make(http.Header), Body: io.NopCloser(body)}
					parsed, taskErr := adaptor.ParseResponse(c, response, info)
					assert.Nil(t, parsed)
					require.NotNil(t, taskErr)
					assert.Equal(t, http.StatusBadGateway, taskErr.StatusCode)
					assert.Equal(t, withCapability, taskErr.NoRetry, "accepted work must not be duplicated; ordinary JSON plugins retain their prior policy")
				})
			}
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
			assert.Equal(t, tc.capability, taskErr.NoRetry, "ordinary JSON plugins retain the official retry behavior")
		})
	}
}
