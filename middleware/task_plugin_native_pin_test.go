package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSharedEndpointKeepsAuthorizedNativeChannel(t *testing.T) {
	const key = "native-pin-collision-test"
	source := taskProtocolPluginSource(key, "1.0.0", `["claimed-model"]`, "/v1/images/generations", `throw new Error("foreign supplier must not parse this request");`)
	source = strings.Replace(source, `fetchMode: "per_task",`, `fetchMode: "per_task", channelTypes: [9876],`, 1)
	_, err := jsplugin.DefaultRegistry.Register(source, jsplugin.Options{})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, jsplugin.DefaultRegistry.Unregister(key)) })
	for _, tc := range []struct {
		name    string
		pin     bool
		typ     int
		status  int
		setting string
	}{
		{"native channel bypasses foreign decoder", true, constant.ChannelTypeOpenAI, http.StatusNoContent, ""},
		{"no pin retains plugin validation", false, constant.ChannelTypeOpenAI, http.StatusBadRequest, ""},
		{"task plugin channel retains plugin validation", true, constant.ChannelTypeTaskPlugin, http.StatusBadRequest, ""},
		{"unbound new-api channel keeps native transport", true, constant.ChannelTypeNewAPI, http.StatusNoContent, ""},
		{"new-api bridge retains bound plugin validation", true, constant.ChannelTypeNewAPI, http.StatusBadRequest, `{"task_plugin_key":"native-pin-collision-test"}`},
		{"unrelated bridge plugin cannot claim endpoint", true, constant.ChannelTypeNewAPI, http.StatusNoContent, `{"task_plugin_key":"unrelated-plugin"}`},
		{"matching channel plugin retains validation", true, 9876, http.StatusBadRequest, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router := gin.New()
			router.POST("/v1/images/generations", func(c *gin.Context) {
				if tc.pin {
					service.GetChannelConstraints(c).AddPin(dto.ChannelPin{ChannelId: 2, Source: dto.PinSourceToken, Rank: dto.PinRankToken})
					_, exists, _ := service.GetChannelConstraints(c).ResolvedPin()
					require.True(t, exists, "authorization pin must persist")
				}
			}, pinTaskPluginEndpoint(func(id int) (*model.Channel, error) {
				assert.Equal(t, 2, id)
				return &model.Channel{Id: id, Type: tc.typ, Setting: &tc.setting}, nil
			}), PrepareTaskPluginEndpoint(), func(c *gin.Context) {
				_, claimed := c.Get(jsplugin.ContextKeyPinnedEndpoint)
				assert.False(t, claimed)
				pin, exists, _ := service.GetChannelConstraints(c).ResolvedPin()
				assert.True(t, exists)
				assert.Equal(t, 2, pin.ChannelId)
				body, readErr := c.GetRawData()
				require.NoError(t, readErr)
				assert.JSONEq(t, `{"model":"claimed-model","prompt":"hello","output_format":"png"}`, string(body))
				c.Status(http.StatusNoContent)
			})
			request := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"model":"claimed-model","prompt":"hello","output_format":"png"}`))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			assert.Equal(t, tc.status, recorder.Code, recorder.Body.String())
		})
	}
}
