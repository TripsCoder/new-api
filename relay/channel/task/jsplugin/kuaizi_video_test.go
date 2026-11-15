package jsplugin

import (
	"bytes"
	"crypto/sha256"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKuaiziVideoBase64JSONLimit(t *testing.T) {
	const createPath = "/ai-open-platform-api/api/v1/services/aigc/video-generation/video-synthesis"
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "plugin-sources", "kuaizi-video", "dist", "kuaizi_video.plugin.js"))
	require.NoError(t, err)
	plugin, err := pluginruntime.CompilePlugin(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	service.InitHttpClient()

	for _, test := range []struct {
		name   string
		model  string
		roles  []string
		bytes  int
		reject bool
	}{
		{"standard over old 4 MiB limit", "wan3.0-video", []string{"first_frame", "last_frame"}, 5_500_000, false},
		{"prime over old 4 MiB limit", "wan3.0-video-prime", []string{"reference_image"}, 5_500_000, false},
		{"exact 50 MB", "wan3.0-video-prime", []string{"reference_image"}, 50_000_000, false},
		{"over 50 MB by one byte", "wan3.0-video", []string{"first_frame", "last_frame"}, 50_000_001, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			const imagePrefix = "data:image/png;base64,"
			// Include both UTF-8 and characters escaped by the host JSON encoder.
			const prompt = "首尾帧🎬 <&>\u2028"
			media := make([]map[string]string, len(test.roles))
			for index, role := range test.roles {
				media[index] = map[string]string{"type": role, "url": imagePrefix + "AAAA"}
			}
			input := map[string]any{"prompt": prompt, "media": media}
			payload := map[string]any{"model": test.model, "input": input}
			initial, err := common.Marshal(payload)
			require.NoError(t, err)
			extra := test.bytes - len(initial)
			media[0]["url"] += strings.Repeat("AAAA", extra/4)
			input["prompt"] = prompt + strings.Repeat("x", extra%4)
			wire, err := common.Marshal(payload)
			require.NoError(t, err)
			require.Len(t, wire, test.bytes)
			checksum := sha256.Sum256(wire)

			var calls atomic.Int32
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				assert.Equal(t, createPath, r.URL.Path)
				assert.Equal(t, http.MethodPost, r.Method)
				assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
				assert.Equal(t, "Bearer fixture-only", r.Header.Get("Authorization"))
				assert.Equal(t, "enable", r.Header.Get("X-DashScope-Async"))
				hash := sha256.New()
				size, err := io.Copy(hash, r.Body)
				assert.NoError(t, err)
				assert.EqualValues(t, test.bytes, size)
				assert.Equal(t, checksum[:], hash.Sum(nil))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusAccepted)
				_, _ = io.WriteString(w, `{"output":{"task_id":"mock-kuaizi","task_status":"PENDING"}}`)
			}))
			defer upstream.Close()

			gin.SetMode(gin.TestMode)
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", bytes.NewReader(wire))
			c.Request.Header.Set("Content-Type", "application/json")
			var body map[string]any
			require.NoError(t, common.DecodeJson(c.Request.Body, &body))
			c.Set(pluginruntime.ContextKeyProtocolRequest, pluginruntime.ProtocolRequestContext{
				RouteRequestContext: pluginruntime.RouteRequestContext{Path: "/v1/videos", Method: http.MethodPost,
					Body: map[string]any{"kind": "json", "value": body}},
				Protocol: "openai_video", Operation: "create", Model: test.model,
			})
			c.Set(pluginruntime.ContextKeyPinnedEndpoint, pluginruntime.PinnedEndpoint{
				Plugin: plugin, Protocol: "openai_video", Model: test.model,
			})
			info := &relaycommon.RelayInfo{
				ChannelMeta: &relaycommon.ChannelMeta{ChannelBaseUrl: upstream.URL + "/ai-open-platform-api",
					ApiKey: "fixture-only", UpstreamModelName: test.model,
					ChannelSetting: dto.ChannelSettings{TLSInsecureSkipVerify: true}},
				TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_fixture"}, OriginModelName: test.model,
			}
			adaptor := New(plugin)
			adaptor.Init(info)
			taskErr := adaptor.ValidateRequestAndSetAction(c, info)
			if test.reject {
				require.NotNil(t, taskErr)
				assert.Equal(t, http.StatusBadRequest, taskErr.StatusCode)
				assert.Contains(t, taskErr.Message, "50,000,000")
				assert.Zero(t, calls.Load())
				return
			}
			require.Nil(t, taskErr)
			outbound, err := adaptor.BuildRequestBody(c, info)
			require.NoError(t, err)
			response, err := adaptor.DoRequest(c, info, outbound)
			require.NoError(t, err)
			parsed, parseErr := adaptor.ParseResponse(c, response, info)
			require.Nil(t, parseErr)
			assert.Equal(t, "mock-kuaizi", parsed.UpstreamTaskID)
			assert.EqualValues(t, 1, calls.Load())
		})
	}
}
