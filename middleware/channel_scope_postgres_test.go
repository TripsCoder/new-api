package middleware

import (
	"context"
	"crypto/sha256"
	"fmt"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	adaptor "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgreSQLSameModelCaseAliasesKeepChannelContractsAndHistory(t *testing.T) {
	dsn := os.Getenv("CHANNEL_SCOPE_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL DSN not supplied")
	}
	require.Contains(t, dsn, "port=54377")
	require.Contains(t, dsn, "dbname=six_config_test")
	oldDB, oldRegistry, oldCache := model.DB, pluginruntime.DefaultRegistry, common.MemoryCacheEnabled
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	schemaName := fmt.Sprintf("sc%x", time.Now().UnixNano())
	admin, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	require.NoError(t, admin.Exec("CREATE SCHEMA "+schemaName).Error)
	t.Cleanup(func() { require.NoError(t, admin.Exec("DROP SCHEMA "+schemaName+" CASCADE").Error) })
	db, err := gorm.Open(postgres.Open(dsn+" search_path="+schemaName), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	model.DB = db
	pluginruntime.DefaultRegistry = pluginruntime.NewRegistry()
	common.SetDatabaseTypes(common.DatabaseTypePostgreSQL, common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		common.MemoryCacheEnabled = false
		require.NoError(t, db.Migrator().DropTable(&model.ChannelModelConfiguration{}, &model.Ability{}, &model.TaskPlugin{}, &model.Channel{}))
		model.DB = oldDB
		pluginruntime.DefaultRegistry = oldRegistry
		common.MemoryCacheEnabled = oldCache
		common.SetDatabaseTypes(oldMain, oldLog)
	})
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.ChannelModelConfiguration{}, &model.TaskPlugin{}))
	source := func(key, modelName, version, path string) string {
		return fmt.Sprintf(`export const meta={apiVersion:1,key:%q,name:"scope",version:%q,author:{name:"test"},models:[%q],fetchMode:"per_task",protocols:["openai_video"]};export const protocols={openai_video:{decodeRequest(ctx){return {kind:"submit",model:ctx.model,action:"video_generate",requestBody:{operation:"video_generate",input:ctx.body.value}}},render(){return {}}}};export function buildSubmitRequest(ctx){if(ctx.upstreamModel!==%q)throw new Error("cross supplier model");return {url:ctx.baseUrl+%q,method:"POST",body:{...ctx.requestBody.input,model:ctx.upstreamModel}}};export function parseSubmitResponse(){return {taskId:"accepted"}};export function buildQueryRequest(ctx){return {url:ctx.baseUrl+%q+ctx.taskId}};export function parseTaskResult(){return {status:"UNKNOWN"}};export function listArtifacts(){return []};export function buildContentRequest(){return {url:"https://provider.invalid/content"}};`, key, version, modelName, modelName, path+"/submit", path+"/tasks/")
	}
	alpha, err := pluginruntime.DefaultRegistry.Register(source("paisio_media", "Shared-Video", "2.0.1", "/alpha"), pluginruntime.Options{})
	require.NoError(t, err)
	beta, err := pluginruntime.DefaultRegistry.Register(source("yuxibox_media", "shared-video", "2.0.1", "/beta"), pluginruntime.Options{})
	require.NoError(t, err)
	require.Empty(t, pluginruntime.DefaultRegistry.RoutingErrors())
	require.Len(t, pluginruntime.DefaultRegistry.Generation().LookupEndpointCandidates("POST", "/v1/videos", "SHARED-VIDEO"), 2)
	channels := []model.Channel{}
	for i, fixture := range []struct{ key, name, marker, price string }{{"paisio_media", "Shared-Video", "alpha", "0.02"}, {"yuxibox_media", "shared-video", "beta", "0.05"}} {
		setting := `{"task_plugin_key":"` + fixture.key + `"}`
		ch := model.Channel{Id: 701 + i, Type: 61, Status: 1, Group: "default", Models: fixture.name, Key: "fixture-only-" + fixture.marker, Setting: &setting}
		require.NoError(t, db.Create(&ch).Error)
		require.NoError(t, ch.UpdateAbilities(db))
		channels = append(channels, ch)
		document := modelconfig.Empty(fixture.key)
		document.Groups["g"] = modelconfig.Group{Name: "per channel", Modes: map[string]modelconfig.Mode{"text_video": {Enabled: true, Input: map[string]any{"supplier_tag": fixture.marker, "seconds": float64(5 + i)}, Billing: &modelconfig.Billing{Expression: fixture.price, Currency: "USD", Confirmed: true}}, "image_video": {Enabled: false, Input: map[string]any{}}}}
		document.Bindings[fixture.name] = map[string]modelconfig.Binding{"text_video": {GroupID: "g"}, "image_video": {GroupID: "g"}}
		document.Bindings["unconfirmed-model"] = map[string]modelconfig.Binding{"image_video": {GroupID: "g"}}
		_, err := model.SaveChannelModelConfiguration(context.Background(), ch.Id, 1, document, 0)
		require.NoError(t, err)
		stored, err := model.GetChannelModelConfiguration(context.Background(), ch.Id, 0)
		require.NoError(t, err)
		_, _, err = modelconfig.Resolve(stored, fixture.name, "text_video", map[string]any{})
		require.NoError(t, err)
		_, _, err = modelconfig.Resolve(stored, fixture.name, "image_video", map[string]any{})
		require.ErrorContains(t, err, "disabled")
		_, _, err = modelconfig.Resolve(stored, "unconfirmed-model", "image_video", map[string]any{})
		require.ErrorContains(t, err, "disabled")
	}
	for _, cached := range []bool{false, true} {
		common.MemoryCacheEnabled = cached
		model.InitChannelCache()
		for i, ch := range channels {
			filters := []dto.ChannelFilter{{Kind: dto.FilterTaskPluginIdentity, TaskPluginKey: ch.GetSetting().TaskPluginKey, TaskPluginKeys: []string{ch.GetSetting().TaskPluginKey}}}
			selected, err := model.GetRandomSatisfiedChannel("default", "SHARED-VIDEO", 0, filters)
			require.NoError(t, err)
			require.NotNil(t, selected)
			require.Equal(t, ch.Id, selected.Id)
			router := gin.New()
			reached := false
			router.POST("/v1/videos", PinTaskPluginEndpoint(), PrepareTaskPluginEndpoint(), func(c *gin.Context) {
				reached = true
				require.Nil(t, SetupContextForSelectedChannel(c, &ch, "SHARED-VIDEO"))
				pinned := c.MustGet(pluginruntime.ContextKeyPinnedPlugin).(pluginruntime.PinnedPlugin)
				wanted := alpha
				if i == 1 {
					wanted = beta
				}
				require.Same(t, wanted, pinned.Plugin)
				info := &relaycommon.RelayInfo{OriginModelName: "SHARED-VIDEO", TaskRelayInfo: &relaycommon.TaskRelayInfo{}, ChannelMeta: &relaycommon.ChannelMeta{ChannelId: ch.Id, ChannelType: 61, UpstreamModelName: "SHARED-VIDEO", ChannelBaseUrl: "https://provider.invalid", ApiKey: "fixture"}}
				require.Nil(t, adaptor.New(pinned.Plugin).ValidateRequestAndSetAction(c, info))
				require.Equal(t, ch.Models, info.UpstreamModelName)
				require.Equal(t, "SHARED-VIDEO", info.OriginModelName)
				resolved := c.MustGet(modelconfig.ContextKeyResolvedMode).(modelconfig.ResolvedMode)
				expectedPrice := "0.02"
				tag := "alpha"
				if i == 1 {
					expectedPrice = "0.05"
					tag = "beta"
				}
				require.Equal(t, expectedPrice, resolved.Definition.Billing.Expression)
				body := c.MustGet("task_request").(map[string]any)
				require.Equal(t, tag, body["input"].(map[string]any)["supplier_tag"])
				var descriptor map[string]any
				require.NoError(t, pinned.Plugin.Engine.CallInto(context.Background(), &descriptor, "buildSubmitRequest", map[string]any{"upstreamModel": info.UpstreamModelName, "baseUrl": "https://provider.invalid", "requestBody": body}))
				require.Contains(t, descriptor["url"], "/"+tag+"/submit")
				c.Status(204)
			})
			request := httptest.NewRequest("POST", "/v1/videos", strings.NewReader(`{"model":"SHARED-VIDEO","prompt":"fixture"}`))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			require.True(t, reached)
			require.Equal(t, 204, recorder.Code, recorder.Body.String())
		}
	}
	// The same model in another channel cannot change an older task's polling
	// source, even after a newer active provider has been selected above.
	historicalSource := source("paisio_media", "Shared-Video", "1.1.0", "/historical-alpha")
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(historicalSource)))
	require.NoError(t, db.Create(&model.TaskPlugin{Key: "paisio_media", Version: "1.1.0", APIVersion: 1, Source: model.LongText(historicalSource), SourceHash: digest}).Error)
	task := &model.Task{Platform: constant.TaskPlatform("paisio_media")}
	task.PrivateData.Execution = &model.TaskExecutionSnapshot{TaskPlugin: &model.TaskPluginSnapshot{Key: "paisio_media", Version: "1.1.0", SourceSHA256: digest}}
	retained, err := service.ResolvePinnedTaskPlugin(task)
	require.NoError(t, err)
	var query map[string]any
	require.NoError(t, retained.Engine.CallInto(context.Background(), &query, "buildQueryRequest", map[string]any{"baseUrl": "https://provider.invalid", "taskId": "old-task"}))
	require.Equal(t, "https://provider.invalid/historical-alpha/tasks/old-task", query["url"])
}
