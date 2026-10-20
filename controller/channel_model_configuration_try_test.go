package controller

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestChannelConfigurationRealCallUsesNormalBillingAndTask(t *testing.T) {
	require.NoError(t, i18n.Init())
	db, dialect := openTaskDialectDatabase(t, &model.User{}, &model.Channel{}, &model.Task{}, &model.Log{}, &model.Ability{}, &model.ChannelModelConfiguration{}, &model.TaskPlugin{})
	previousDB, previousLog, previousRegistry := model.DB, model.LOG_DB, jsplugin.DefaultRegistry
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	oldRedis, oldMemory, oldBatch, oldConsume, oldExport := common.RedisEnabled, common.MemoryCacheEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled, common.DataExportEnabled
	model.DB, model.LOG_DB = db, db
	common.SetDatabaseTypes(dialect, dialect)
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	common.RedisEnabled, common.MemoryCacheEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled, common.DataExportEnabled = false, true, false, true, false
	t.Cleanup(func() {
		model.DB, model.LOG_DB, jsplugin.DefaultRegistry = previousDB, previousLog, previousRegistry
		common.SetDatabaseTypes(oldMain, oldLog)
		common.RedisEnabled, common.MemoryCacheEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled, common.DataExportEnabled = oldRedis, oldMemory, oldBatch, oldConsume, oldExport
	})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	source := `
 export const meta={apiVersion:1,key:"paisio_media",name:"Isolated real test",version:"2.0.0",author:{name:"test"},models:["fixture-image"],fetchMode:"per_task",protocols:[{name:"openai_image",models:["fixture-image"]}],usageSchema:{request_count:{type:"number",unit:"count"}}};
 export const protocols={openai_image:{decodeRequest:function(ctx){return {kind:"submit",model:ctx.model,action:"image_generate",requestBody:{operation:"image_generate",input:ctx.body.value,uploads:[]}}},render:function(){return {data:[]}}}};
 export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/generate",method:"POST",headers:{Authorization:"Bearer "+ctx.apiKey},body:ctx.requestBody.input}}
 export function parseSubmitResponse(){return {taskId:"isolated-vendor",taskData:{data:[]},immediate:{status:"SUCCESS"}}}
 export function extractUsage(){return {request_count:1}};export function extractUsageOnComplete(){return {request_count:1}}
 export function buildQueryRequest(){throw new Error("immediate task must not poll")};export function parseTaskResult(){return {status:"SUCCESS"}}
 `
	_, err := jsplugin.DefaultRegistry.Register(source, jsplugin.Options{})
	require.NoError(t, err)
	initial := int(10 * common.QuotaPerUnit)
	user := model.User{Username: "isolated_operator", AffCode: "isolated_operator", Quota: initial, Status: common.UserStatusEnabled, Group: "default", Role: common.RoleAdminUser}
	require.NoError(t, db.Create(&user).Error)
	setting := `{"task_plugin_key":"paisio_media"}`
	base := server.URL
	channel := model.Channel{Type: 61, Name: "isolated-real-test", Group: "default", Status: 1, Models: "fixture-image", Key: "isolated-secret-must-not-appear", BaseURL: &base, Setting: &setting}
	require.NoError(t, db.Create(&channel).Error)
	require.NoError(t, db.Create(&model.Ability{Group: "default", Model: "fixture-image", ChannelId: channel.Id, Enabled: true}).Error)
	model.InitChannelCache()
	amount := 2.0
	document := modelconfig.Empty("paisio_media")
	document.Groups["reviewed"] = modelconfig.Group{Name: "reviewed", Modes: map[string]modelconfig.Mode{"text_image": {Enabled: true, Input: map[string]any{}, Cost: modelconfig.Cost{Amount: &amount, Unit: "request", Currency: "CNY", Confirmed: true, Source: &modelconfig.Source{URL: "https://provider.invalid/pricing", Status: "operator_confirmed"}}, Billing: &modelconfig.Billing{Expression: `u("request_count") * 0.01`, Currency: "USD", Confirmed: true}}}}
	document.Bindings["fixture-image"] = map[string]modelconfig.Binding{"text_image": {GroupID: "reviewed"}}
	document, err = model.SaveChannelModelConfiguration(t.Context(), channel.Id, user.Id, document, 0)
	require.NoError(t, err)
	call := func(limit float64) *httptest.ResponseRecorder {
		body, err := common.Marshal(map[string]any{"revision": document.Revision, "model": "fixture-image", "mode": "text_image", "input": map[string]any{"prompt": "isolated test"}, "budget": modelconfig.TestCallBudget{MaxEstimatedUSD: limit, AcceptCharge: true}})
		require.NoError(t, err)
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Params = gin.Params{{Key: "id", Value: strconv.Itoa(channel.Id)}}
		c.Set("id", user.Id)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/channel/1/model-configuration/try", bytes.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		TryChannelModelConfiguration(c)
		require.NotContains(t, recorder.Body.String(), channel.Key)
		return recorder
	}
	rejected := call(0.005)
	require.Contains(t, rejected.Body.String(), "test_budget_exceeded")
	require.Zero(t, calls.Load())
	accepted := call(0.02)
	require.Contains(t, accepted.Body.String(), `"actualCall":true`)
	require.Equal(t, int32(1), calls.Load())
	var tasks []model.Task
	require.NoError(t, db.Find(&tasks).Error)
	require.Len(t, tasks, 1)
	task := tasks[0]
	require.Equal(t, user.Id, task.UserId)
	require.Equal(t, channel.Id, task.ChannelId)
	require.Equal(t, constant.TaskPlatform("paisio_media"), task.Platform)
	require.Equal(t, model.TaskStatus(model.TaskStatusSuccess), task.Status)
	require.True(t, task.ResultRetrievable())
	require.NotEmpty(t, task.Data)
	require.NotNil(t, task.PrivateData.Execution)
	require.Equal(t, document.Revision, task.PrivateData.Execution.ChannelModelConfigurationRevision)
	require.Equal(t, "2.0.0", task.PrivateData.Execution.TaskPlugin.Version)
	require.NotEmpty(t, task.PrivateData.Execution.TaskPlugin.SourceSHA256)
	require.NotNil(t, task.PrivateData.BillingContext.UpstreamCost)
	require.Equal(t, 2.0, *task.PrivateData.BillingContext.UpstreamCost.Actual)
	require.Equal(t, "CNY", task.PrivateData.BillingContext.UpstreamCost.Cost.Currency)

	own := httptest.NewRecorder()
	ownCtx, _ := gin.CreateTestContext(own)
	ownCtx.Set("id", user.Id)
	ownCtx.Params = gin.Params{{Key: "id", Value: strconv.Itoa(channel.Id)}, {Key: "task_id", Value: task.TaskID}}
	ownCtx.Request = httptest.NewRequest(http.MethodGet, "/api/channel/1/model-configuration/try/fixture", nil)
	GetChannelModelConfigurationRealTask(ownCtx)
	require.Contains(t, own.Body.String(), `"providerCost"`)
	require.NotContains(t, own.Body.String(), channel.Key)
	other := httptest.NewRecorder()
	otherCtx, _ := gin.CreateTestContext(other)
	otherCtx.Set("id", user.Id+1)
	otherCtx.Params = ownCtx.Params
	otherCtx.Request = ownCtx.Request
	GetChannelModelConfigurationRealTask(otherCtx)
	require.Equal(t, http.StatusNotFound, other.Code)
	require.NotContains(t, other.Body.String(), `"providerCost"`)
	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	require.Equal(t, initial-common.QuotaRound(0.01*common.QuotaPerUnit), updated.Quota)
}
