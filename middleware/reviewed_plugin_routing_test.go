package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Regression for the 2026-10-25 XCM 400: a registered plugin must also be
// eligible for its saved interface/model binding. No provider transport runs.
func TestReviewedPluginRoutingUsesInstalledSourcesAndSavedInterfaces(t *testing.T) {
	directory := os.Getenv("REVIEWED_PLUGIN_ROUTING_FIXTURE_DIR")
	if directory == "" {
		directory = "../plugin-sources/media-providers/six-v2/dist"
	}
	for _, tc := range []struct {
		provider, model, version string
		unreviewed               bool
	}{
		{"xcmapi_media", "seedance-2.5-G3-D1", "2.1.7", false},
		{"paisio_media", "routing-fixture-future-video", "2.1.6", false},
		{"xcmapi_media", "seedance-2.5-G3-D1", "2.1.8", true},
	} {
		t.Run(tc.provider+"/"+tc.version, func(t *testing.T) {
			previousDB, previousRegistry := model.DB, pluginruntime.DefaultRegistry
			previousType := common.MainDatabaseType()
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
			require.NoError(t, err)
			model.DB = db
			common.SetMainDatabaseType(common.DatabaseTypeSQLite)
			pluginruntime.DefaultRegistry = pluginruntime.NewRegistry()
			t.Cleanup(func() {
				model.DB, pluginruntime.DefaultRegistry = previousDB, previousRegistry
				common.SetMainDatabaseType(previousType)
				sqlDB, err := db.DB()
				require.NoError(t, err)
				require.NoError(t, sqlDB.Close())
			})
			require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.ChannelModelConfiguration{}))
			raw, err := os.ReadFile(filepath.Join(directory, tc.provider+".plugin.js"))
			require.NoError(t, err)
			source := string(raw)
			if tc.unreviewed {
				source = strings.ReplaceAll(source, `"version": "2.1.7"`, `"version": "2.1.8"`)
			}
			plugin, err := pluginruntime.DefaultRegistry.Register(source, pluginruntime.Options{})
			require.NoError(t, err)
			require.Equal(t, tc.version, plugin.Meta.Version)
			require.NotContains(t, plugin.Meta.Models, tc.model, "fixture must exercise the configured-interface path")
			interfaceID := "interface:0d35f19e841e7b7f"
			if tc.provider == "paisio_media" {
				interfaceID = ""
				for id, value := range plugin.Meta.ParameterInterfaces {
					entry := value.(map[string]any)
					modes, _ := entry["modes"].(map[string]any)
					if entry["kind"] == "video" && modes["text_video"] != nil {
						interfaceID = id
						break
					}
				}
			}
			require.NotEmpty(t, interfaceID)
			setting := `{"task_plugin_key":"` + tc.provider + `"}`
			channel := model.Channel{Id: 11, Type: 61, Status: 1, Models: tc.model, Key: "isolated-no-network", Setting: &setting}
			require.NoError(t, db.Create(&channel).Error)
			document := modelconfig.Empty(tc.provider)
			document.Revision = 1
			document.Groups["saved"] = modelconfig.Group{Name: "existing binding", Modes: map[string]modelconfig.Mode{"text_video": {Enabled: true, Input: map[string]any{}}}}
			document.Bindings[tc.model] = map[string]modelconfig.Binding{"text_video": {GroupID: "saved", Protocol: &modelconfig.ProtocolBinding{TemplateModel: interfaceID, Confirmed: true}}}
			payload, err := common.Marshal(document)
			require.NoError(t, err)
			// Seed an existing persisted binding; this regression does not change
			// configuration-save semantics, credentials, discovery or billing.
			require.NoError(t, db.Create(&model.ChannelModelConfiguration{ChannelID: channel.Id, Revision: 1, Payload: model.LongText(payload)}).Error)
			candidates := service.ManualProtocolCandidates(context.Background(), pluginruntime.DefaultRegistry.Generation(), "POST", "/v1/videos", tc.model, channel.Id)
			if tc.unreviewed {
				require.Empty(t, candidates, "future versions must remain blocked")
				return
			}
			require.Len(t, candidates, 1)
			require.Equal(t, plugin, candidates[0].Plugin)
			require.True(t, candidates[0].ConfigurationBound)
			router := gin.New()
			router.POST("/v1/videos", PinTaskPluginEndpoint(), PrepareTaskPluginEndpoint(), func(c *gin.Context) {
				pinned := c.MustGet(pluginruntime.ContextKeyPinnedEndpoint).(pluginruntime.PinnedEndpoint)
				require.Equal(t, plugin, pinned.Plugin)
				require.True(t, pinned.Candidates[0].ConfigurationBound)
				c.Status(http.StatusNoContent)
			})
			request := httptest.NewRequest("POST", "/v1/videos", strings.NewReader(`{"model":"`+tc.model+`","prompt":"isolated fixture","seconds":5,"resolution":"720p"}`))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusNoContent, recorder.Code, recorder.Body.String())
			current, err := model.GetChannelModelConfiguration(context.Background(), channel.Id, 0)
			require.NoError(t, err)
			require.Equal(t, document, current)
		})
	}
}
