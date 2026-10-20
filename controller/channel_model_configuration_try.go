package controller

import (
	"bytes"
	"io"
	"net/http"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	taskdto "github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	jspluginadaptor "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// A real test is an ordinary durable, billable task owned by the signed-in
// operator. There is no direct supplier fetch, free bypass, or special wallet.
func TryChannelModelConfiguration(c *gin.Context) {
	channel, key, err := modelConfigurationChannel(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	var request struct {
		Revision int64                      `json:"revision"`
		Model    string                     `json:"model"`
		Mode     string                     `json:"mode"`
		Input    map[string]any             `json:"input"`
		Budget   modelconfig.TestCallBudget `json:"budget"`
	}
	if c.ShouldBindJSON(&request) != nil {
		common.ApiErrorMsg(c, "Invalid model configuration JSON")
		return
	}
	if err = request.Budget.Validate(); err != nil {
		common.ApiError(c, err)
		return
	}
	document, err := model.GetChannelModelConfiguration(c.Request.Context(), channel.Id, 0)
	if err != nil {
		common.ApiErrorMsg(c, "Save the configuration before a real call")
		return
	}
	if request.Revision <= 0 || document.Revision != request.Revision {
		c.JSON(http.StatusConflict, gin.H{"success": false, "message": "Channel model configuration changed; reload before a real call"})
		return
	}
	if _, exists := document.Bindings[request.Model][request.Mode]; !exists {
		common.ApiErrorMsg(c, "Select a configured model and generation mode")
		return
	}
	plugin, ok := jsplugin.DefaultRegistry.Get(key)
	if !ok || !jsplugin.DefaultRegistry.Enabled() || !modelconfig.ReviewedPluginVersion(plugin.Meta.Version) || (!slices.Contains(plugin.Meta.Models, modelconfig.CanonicalReviewedModelName(key, request.Model)) && modelconfig.ManualProtocolFor(document, request.Model, request.Mode) == nil) {
		common.ApiErrorMsg(c, "Activate the reviewed version 2 plugin before a real call")
		return
	}
	actorID := c.GetInt("id")
	if actorID <= 0 {
		common.ApiErrorMsg(c, "Authentication required")
		return
	}
	actor, err := model.GetUserCache(actorID)
	if err != nil || actor.Status != common.UserStatusEnabled {
		common.ApiErrorMsg(c, "The current account is unavailable")
		return
	}
	protocol := "openai_video"
	operation := "create"
	if strings.HasSuffix(request.Mode, "image") {
		protocol = "openai_image"
		operation = "generate"
	}
	if request.Mode == "edit_image" {
		operation = "edit"
	}
	protocolRequest := jsplugin.ProtocolRequestContext{Protocol: protocol, Operation: operation, Model: request.Model, UpstreamModel: request.Model, RouteRequestContext: jsplugin.RouteRequestContext{Method: http.MethodPost, Body: map[string]any{"kind": "json", "value": request.Input}}}
	decoded, err := plugin.Engine.CallPath(c.Request.Context(), "protocols", []string{protocol, "decodeRequest"}, protocolRequest.JSValueFor(plugin.Meta))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	resolved, ok := decoded.(map[string]any)
	if !ok {
		common.ApiErrorMsg(c, "Invalid task decoder result")
		return
	}
	body, ok := resolved["requestBody"].(map[string]any)
	if !ok {
		common.ApiErrorMsg(c, "Invalid task decoder body")
		return
	}
	input, ok := body["input"].(map[string]any)
	if !ok {
		common.ApiErrorMsg(c, "Invalid decoded task input")
		return
	}
	normalizedOperation, _ := body["operation"].(string)
	contractMode, _ := body["contractMode"].(string)
	mode, err := modelconfig.InferConfiguredMode(document, request.Model, normalizedOperation, input, body["uploads"], contractMode)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if mode != request.Mode {
		common.ApiErrorMsg(c, "Input references do not match the selected generation mode")
		return
	}
	// Standard channel selection still enforces the actor's model/group access.
	// A stricter pin prevents a second paid attempt after an uncertain response.
	actor.WriteContext(c)
	common.SetContextKey(c, constant.ContextKeyUserId, actorID)
	common.SetContextKey(c, constant.ContextKeyOriginalModel, request.Model)
	common.SetContextKey(c, constant.ContextKeyUsingGroup, actor.Group)
	c.Set("group", actor.Group)
	constraints := service.GetChannelConstraints(c)
	constraints.RequestedChannelID = channel.Id
	constraints.AddPin(taskdto.ChannelPin{ChannelId: channel.Id, Source: taskdto.PinSourceToken, Rank: taskdto.PinRankToken, RetryMode: taskdto.PinRetrySingleAttempt})
	c.Set(jsplugin.ContextKeyPinnedPlugin, jsplugin.PinnedPlugin{Plugin: plugin, Generation: jsplugin.DefaultRegistry.Generation()})
	c.Set(jsplugin.ContextKeyPinnedEndpoint, jsplugin.PinnedEndpoint{Plugin: plugin, Protocol: protocol, Model: request.Model})
	c.Set(jsplugin.ContextKeyProtocolRequest, protocolRequest)
	c.Set("task_request", body)
	if err = jspluginadaptor.PinChannelModelConfiguration(c, channel.Id, document); err != nil {
		common.ApiError(c, err)
		return
	}
	c.Set(modelconfig.ContextKeyTestBudget, request.Budget)
	c.Set("platform", key)
	c.Set("task_action", normalizedOperation)
	// Use the selected channel's ordinary key selector and the same task relay.
	channel, err = model.GetChannelById(channel.Id, true)
	if err != nil {
		common.ApiErrorMsg(c, "Channel is unavailable")
		return
	}
	if setupErr := middleware.SetupContextForSelectedChannel(c, channel, request.Model); setupErr != nil {
		common.ApiErrorMsg(c, "Channel is unavailable")
		return
	}
	raw, err := common.Marshal(request.Input)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.CleanupBodyStorage(c)
	c.Set(common.KeyRequestBody, nil)
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	c.Request.ContentLength = int64(len(raw))
	defer common.CleanupBodyStorage(c)
	info, err := relaycommon.GenRelayInfo(c, types.RelayFormatTask, nil, nil)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	info.IsPlayground = true
	info.TokenId = 0
	info.TokenKey = ""
	info.Action = normalizedOperation
	info.UserSetting.BillingPreference = "wallet_only"
	outcome, taskErr := executeTaskSubmission(c, info)
	if taskErr != nil {
		respondTaskSubmissionError(c, taskErr)
		return
	}
	common.ApiSuccess(c, gin.H{"kind": "real_call", "actualCall": true, "taskId": outcome.Task.TaskID, "status": outcome.Task.Status, "estimatedUSD": float64(info.PriceData.Quota) / common.QuotaPerUnit})
}

// Read only the signed-in operator's task on this exact channel.
func GetChannelModelConfigurationRealTask(c *gin.Context) {
	channel, key, err := modelConfigurationChannel(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	task, exists, err := model.GetByTaskId(c.GetInt("id"), c.Param("task_id"))
	if err != nil || !exists || task == nil || task.ChannelId != channel.Id || string(task.Platform) != key {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "Task not found"})
		return
	}
	result := gin.H{"taskId": task.TaskID, "status": task.Status, "progress": task.Progress}
	if task.PrivateData.BillingContext != nil && task.PrivateData.BillingContext.UpstreamCost != nil {
		cost := task.PrivateData.BillingContext.UpstreamCost
		result["providerCost"] = gin.H{"currency": cost.Cost.Currency, "estimate": cost.Estimate, "actual": cost.Actual, "status": cost.Status}
	}
	common.ApiSuccess(c, result)
}
