package middleware

import (
	"context"
	"fmt"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	adaptor "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestManualProtocolBindingFullRequestAndDiscoveryAbsence(t *testing.T) {
	cases := []struct {
		name   string
		driver gorm.Dialector
		kind   common.DatabaseType
	}{{"sqlite", sqlite.Open(":memory:"), common.DatabaseTypeSQLite}}
	if dsn := os.Getenv("CHANNEL_CONFIG_TEST_MYSQL_DSN"); dsn != "" {
		require.Contains(t, dsn, "127.0.0.1:33177")
		require.Contains(t, dsn, "/six_config_test")
		cases = append(cases, struct {
			name   string
			driver gorm.Dialector
			kind   common.DatabaseType
		}{"mysql", mysql.Open(dsn), common.DatabaseTypeMySQL})
	}
	if dsn := os.Getenv("CHANNEL_CONFIG_TEST_POSTGRES_DSN"); dsn != "" {
		require.Contains(t, dsn, "port=54377")
		require.Contains(t, dsn, "dbname=six_config_test")
		cases = append(cases, struct {
			name   string
			driver gorm.Dialector
			kind   common.DatabaseType
		}{"postgres", postgres.Open(dsn), common.DatabaseTypePostgreSQL})
	}
	if os.Getenv("CHANNEL_CONFIG_TEST_REQUIRE_THREE") == "1" {
		require.Len(t, cases, 3)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			oldDB := model.DB
			oldRegistry := pluginruntime.DefaultRegistry
			oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
			db, err := gorm.Open(tc.driver, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent), NamingStrategy: schema.NamingStrategy{TablePrefix: fmt.Sprintf("mb%x_", time.Now().UnixNano())}})
			require.NoError(t, err)
			model.DB = db
			common.SetDatabaseTypes(tc.kind, common.DatabaseTypeSQLite)
			pluginruntime.DefaultRegistry = pluginruntime.NewRegistry()
			t.Cleanup(func() {
				require.NoError(t, db.Migrator().DropTable(&model.Ability{}, &model.TaskPlugin{}, &model.ChannelModelConfiguration{}, &model.Channel{}))
				model.DB = oldDB
				pluginruntime.DefaultRegistry = oldRegistry
				common.SetDatabaseTypes(oldMain, oldLog)
			})
			require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.ChannelModelConfiguration{}, &model.Ability{}, &model.TaskPlugin{}))
			source, err := os.ReadFile("../plugin-sources/media-providers/six-v2/dist/paisio_media.plugin.js")
			require.NoError(t, err)
			plugin, err := pluginruntime.DefaultRegistry.Register(string(source), pluginruntime.Options{})
			require.NoError(t, err)
			template := ""
			raw, err := modelconfig.ProviderCatalog("paisio_media")
			require.NoError(t, err)
			for name, raw := range raw.(map[string]any)["models"].(map[string]any) {
				item := raw.(map[string]any)
				modes, _ := item["modes"].(map[string]any)
				if _, ok := modes["text_image"]; ok {
					template = name
					break
				}
			}
			require.NotEmpty(t, template)
			setting := `{"task_plugin_key":"paisio_media"}`
			ch := model.Channel{Id: 431, Type: 61, Status: 1, Models: "future-image", Key: "isolated-no-network", Setting: &setting}
			require.NoError(t, db.Create(&ch).Error)
			document := modelconfig.Empty("paisio_media")
			document.Groups["g"] = modelconfig.Group{Name: "manual", Modes: map[string]modelconfig.Mode{"text_image": {Enabled: true, Input: map[string]any{}, Protocol: &modelconfig.ProtocolBinding{TemplateModel: template, Confirmed: true}}}}
			document.Bindings["future-image"] = map[string]modelconfig.Binding{"text_image": {GroupID: "g"}}
			saved, err := model.SaveChannelModelConfiguration(context.Background(), ch.Id, 1, document, 0)
			require.NoError(t, err)
			router := gin.New()
			reached := false
			router.POST("/v1/images/generations", PinTaskPluginEndpoint(), PrepareTaskPluginEndpoint(), func(c *gin.Context) {
				reached = true
				pin := c.MustGet(pluginruntime.ContextKeyPinnedEndpoint).(pluginruntime.PinnedEndpoint)
				require.Equal(t, plugin, pin.Plugin)
				require.True(t, pin.Candidates[0].ConfigurationBound)
				info := &relaycommon.RelayInfo{TaskRelayInfo: &relaycommon.TaskRelayInfo{}, OriginModelName: "future-image", ChannelMeta: &relaycommon.ChannelMeta{ChannelId: ch.Id, UpstreamModelName: "future-image", ChannelType: 61, ChannelBaseUrl: "https://provider.invalid", ApiKey: "isolated"}}
				require.Nil(t, adaptor.New(plugin).ValidateRequestAndSetAction(c, info))
				body := c.MustGet("task_request").(map[string]any)
				require.Equal(t, template, body["protocolTemplate"])
				c.Status(204)
			})
			// No discovery endpoint exists in the fixture: absence cannot prevent routing.
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest("POST", "/v1/images/generations", strings.NewReader(`{"model":"future-image","prompt":"fixture"}`))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(recorder, request)
			require.True(t, reached)
			require.Equal(t, 204, recorder.Code, recorder.Body.String())
			current, err := model.GetChannelModelConfiguration(context.Background(), ch.Id, 0)
			require.NoError(t, err)
			require.Equal(t, saved, current)
			require.NoError(t, db.First(&ch, 431).Error)
			require.Equal(t, "isolated-no-network", ch.Key)
			require.Equal(t, "future-image", ch.Models)
			require.Equal(t, 1, ch.Status)
			require.NoError(t, db.Create(&model.TaskPlugin{Key: document.Provider, Version: "2.0.0", Active: true, Enabled: true, Source: "isolated-fixture", SourceHash: "isolated"}).Error)
			saved.Bindings["second-future-image"] = map[string]modelconfig.Binding{"text_image": {GroupID: "g"}}
			saved, err = model.SaveChannelModelConfiguration(context.Background(), ch.Id, 1, saved, saved.Revision, true)
			require.NoError(t, err)
			require.NoError(t, db.First(&ch, 431).Error)
			require.Equal(t, "future-image,second-future-image", ch.Models)
			require.Equal(t, "isolated-no-network", ch.Key)
			require.Equal(t, 1, ch.Status)
			var ability model.Ability
			require.NoError(t, db.Where("channel_id = ? AND model = ?", ch.Id, "second-future-image").First(&ability).Error)
			require.True(t, ability.Enabled)
			saved, err = model.SaveChannelModelConfiguration(context.Background(), ch.Id, 1, saved, saved.Revision, true)
			require.NoError(t, err)
			require.NoError(t, db.First(&ch, 431).Error)
			require.Equal(t, "future-image,second-future-image", ch.Models)

		})
	}
}
