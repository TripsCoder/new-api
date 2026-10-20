package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestChannelModelConfigurationPermissions(t *testing.T) {
	assertChannelRoutePermission(t, http.MethodGet, "/:id/model-configuration/availability", authz.ChannelRead, controller.GetChannelModelConfigurationAvailability)
	assertChannelRoutePermission(t, http.MethodPost, "/:id/model-configuration/try", authz.ChannelSensitiveWrite, controller.TryChannelModelConfiguration)
	assertChannelRoutePermission(t, http.MethodGet, "/:id/model-configuration/try/:task_id", authz.ChannelOperate, controller.GetChannelModelConfigurationRealTask)

	assertChannelRoutePermission(t, http.MethodGet, "/:id/model-configuration", authz.ChannelRead, controller.GetChannelModelConfiguration)
	assertChannelRoutePermission(t, http.MethodPut, "/:id/model-configuration", authz.ChannelSensitiveWrite, controller.SaveChannelModelConfiguration)
	assertChannelRoutePermission(t, http.MethodPost, "/:id/model-configuration/restore", authz.ChannelSensitiveWrite, controller.RestoreChannelModelConfiguration)
	assertChannelRoutePermission(t, http.MethodPost, "/:id/model-configuration/check", authz.ChannelOperate, controller.CheckChannelModelConfiguration)
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	registerChannelRoutes(engine.Group("/api"))
	for _, test := range []struct{ method, path string }{{"GET", "/api/channel/1/model-configuration/availability"}, {"POST", "/api/channel/1/model-configuration/try"}, {"GET", "/api/channel/1/model-configuration/try/task_fixture"}, {"GET", "/api/channel/1/model-configuration"}, {"PUT", "/api/channel/1/model-configuration"}, {"POST", "/api/channel/1/model-configuration/restore"}, {"POST", "/api/channel/1/model-configuration/check"}} {
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, httptest.NewRequest(test.method, test.path, nil))
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	}
}
