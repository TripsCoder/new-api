package service

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPinnedTaskPluginChannelTypesUsesPinnedGenerationIndex(t *testing.T) {
	registry := jsplugin.NewRegistry()
	plugin, err := registry.Register(channelSelectTaskPluginSource("legacy-select", constant.ChannelTypeKling), jsplugin.Options{})
	require.NoError(t, err)

	c, _ := gin.CreateTestContext(nil)
	c.Set(jsplugin.ContextKeyPinnedPlugin, jsplugin.PinnedPlugin{
		Generation: registry.Generation(),
		Plugin:     plugin,
	})

	types, keys := pinnedTaskPluginIdentities(c, "legacy-select")
	assert.Equal(t, []int{constant.ChannelTypeKling}, types)
	assert.Equal(t, []string{"legacy-select"}, keys)
	types, keys = pinnedTaskPluginIdentities(c, "another-plugin")
	assert.Empty(t, types)
	assert.Empty(t, keys)
	types, keys = pinnedTaskPluginIdentities(nil, "legacy-select")
	assert.Empty(t, types)
	assert.Empty(t, keys)
}

func TestPinnedTaskPluginChannelTypesLeavesGenericChannelsKeyed(t *testing.T) {
	registry := jsplugin.NewRegistry()
	plugin, err := registry.Register(channelSelectTaskPluginSource("generic-select", constant.ChannelTypeTaskPlugin), jsplugin.Options{})
	require.NoError(t, err)

	c, _ := gin.CreateTestContext(nil)
	c.Set(jsplugin.ContextKeyPinnedPlugin, jsplugin.PinnedPlugin{
		Generation: registry.Generation(),
		Plugin:     plugin,
	})

	types, keys := pinnedTaskPluginIdentities(c, "generic-select")
	assert.Empty(t, types)
	assert.Equal(t, []string{"generic-select"}, keys)
}

func TestPinnedTaskPluginChannelTypesIncludesSharedEndpointProviders(t *testing.T) {
	registry := jsplugin.NewRegistry()
	_, err := registry.Register(channelSelectEndpointPluginSource("gemini-select", constant.ChannelTypeGemini), jsplugin.Options{})
	require.NoError(t, err)
	_, err = registry.Register(channelSelectEndpointPluginSource("vertex-select", constant.ChannelTypeVertexAi), jsplugin.Options{})
	require.NoError(t, err)
	candidates := registry.Generation().LookupEndpointCandidates("POST", "/v1/responses", "task-model")
	require.Len(t, candidates, 2)

	c, _ := gin.CreateTestContext(nil)
	c.Set(jsplugin.ContextKeyPinnedPlugin, jsplugin.PinnedPlugin{
		Generation: registry.Generation(),
		Plugin:     candidates[0].Plugin,
	})
	c.Set(jsplugin.ContextKeyPinnedEndpoint, jsplugin.PinnedEndpoint{
		Generation: registry.Generation(),
		Plugin:     candidates[0].Plugin,
		Protocol:   candidates[0].Protocol,
		Operation:  candidates[0].Operation,
		Model:      "task-model",
		Candidates: candidates,
	})

	AppendTaskPluginIdentityFilter(c, candidates[0].Plugin.Meta.Key)
	filters := GetChannelConstraints(c).Filters
	require.Len(t, filters, 1)
	assert.Equal(t, []int{constant.ChannelTypeGemini, constant.ChannelTypeVertexAi}, filters[0].TaskPluginChannelTypes)
	assert.Equal(t, []string{"gemini-select", "vertex-select"}, filters[0].TaskPluginKeys)
}

func channelSelectTaskPluginSource(key string, channelType int) string {
	return fmt.Sprintf(`
export const meta = {
  apiVersion: 1,
  key: %q,
  name: %q,
  version: "1.0.0",
  author: {name: "Test"},
  %s
  models: ["task-model"],
  fetchMode: "per_task",
};
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {taskId: "task"}; }
export function buildQueryRequest() { return {}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
`, key, key, channelSelectChannelTypesField(channelType))
}

func channelSelectEndpointPluginSource(key string, channelType int) string {
	return fmt.Sprintf(`
export const meta = {
  apiVersion: 1,
  key: %q,
  name: %q,
  version: "1.0.0",
  author: {name: "Test"},
  %s
  models: ["task-model"],
  fetchMode: "per_task",
  protocols: [{name: "openai_responses", supports: ["stream", "sync", "background"]}],
};
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {taskId: "task"}; }
export function buildQueryRequest() { return {}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
export const protocols = {openai_responses: {
  decodeRequest: function(ctx) { return {kind: "submit", model: "task-model", requestBody: ctx.body.value}; },
  renderEvents: function() { return {events: [], state: null, done: false}; },
  renderFinal: function() { return {output: []}; },
}};
`, key, key, channelSelectChannelTypesField(channelType))
}

func channelSelectChannelTypesField(channelType int) string {
	if channelType <= 0 || channelType == constant.ChannelTypeTaskPlugin {
		return ""
	}
	return fmt.Sprintf("channelTypes: [%d],", channelType)
}

func TestPinnedTaskPluginChannelTypesIncludesCompatibleTypes(t *testing.T) {
	registry := jsplugin.NewRegistry()
	plugin, err := registry.Register(channelSelectCompatiblePluginSource("sora-select", constant.ChannelTypeSora, constant.ChannelTypeOpenAI), jsplugin.Options{})
	require.NoError(t, err)

	c, _ := gin.CreateTestContext(nil)
	c.Set(jsplugin.ContextKeyPinnedPlugin, jsplugin.PinnedPlugin{
		Generation: registry.Generation(),
		Plugin:     plugin,
	})

	types, keys := pinnedTaskPluginIdentities(c, "sora-select")
	assert.Equal(t, []int{constant.ChannelTypeSora, constant.ChannelTypeOpenAI}, types)
	assert.Equal(t, []string{"sora-select"}, keys)
}

func channelSelectCompatiblePluginSource(key string, channelType, compatibleType int) string {
	return fmt.Sprintf(`
export const meta = {
  apiVersion: 1,
  key: %q,
  name: %q,
  version: "1.0.0",
  author: {name: "Test"},
  channelTypes: [%d, %d],
  models: ["task-model"],
  fetchMode: "per_task",
};
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {taskId: "task"}; }
export function buildQueryRequest() { return {}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
`, key, key, channelType, compatibleType)
}

func TestSharedType61IdentityFilterContainsAllCandidateKeys(t *testing.T) {
	registry := jsplugin.NewRegistry()
	for _, key := range []string{"alpha", "beta"} {
		_, err := registry.Register(channelSelectEndpointPluginSource(key, 0), jsplugin.Options{})
		require.NoError(t, err)
	}
	generation := registry.Generation()
	candidates := generation.LookupEndpointCandidates("POST", "/v1/responses", "task-model")
	require.Len(t, candidates, 2)
	c, _ := gin.CreateTestContext(nil)
	c.Set(jsplugin.ContextKeyPinnedEndpoint, jsplugin.PinnedEndpoint{Generation: generation, Plugin: candidates[0].Plugin, Candidates: candidates})
	AppendTaskPluginIdentityFilter(c, "alpha")
	filters := GetChannelConstraints(c).Filters
	require.Len(t, filters, 1)
	assert.Equal(t, "alpha", filters[0].TaskPluginKey)
	assert.Equal(t, []string{"alpha", "beta"}, filters[0].TaskPluginKeys)
	assert.Empty(t, filters[0].TaskPluginChannelTypes)
}

func TestRequestedChannelKeepsSelectionAmongMultipleEligibleChannels(t *testing.T) {
	db := setupChannelSelectAutoGroupsTest(t)
	createChannelSelectAutoGroupsChannel(t, db, 3101, "default", "selected-model")
	createChannelSelectAutoGroupsChannel(t, db, 3102, "default", "selected-model")
	model.InitChannelCache()
	c := newRequestAutoGroupsContext()
	common.SetContextKey(c, constant.ContextKeyUserGroup, "default")
	constraints := GetChannelConstraints(c)
	constraints.RequestedChannelID = 3102
	constraints.AddPin(dto.ChannelPin{ChannelId: 3102, Source: dto.PinSourceOriginTask})
	param := &RetryParam{Ctx: c, TokenGroup: "default"}

	channel, group, err := SelectChannelForRequest(c, "selected-model", param)
	require.Nil(t, err)
	require.NotNil(t, channel)
	assert.Equal(t, 3102, channel.Id)
	assert.Equal(t, "default", group)
	assert.Equal(t, "default", constraints.RequestedChannelGroup)
	assert.True(t, constraints.SuppressesRetry())
	assert.Len(t, constraints.Pins, 1, "client selection must not create an administrator pin")

	// Revalidation is allowed, but cannot switch either the route or its price.
	param.SetRetry(1)
	channel, group, err = SelectChannelForRequest(c, "selected-model", param)
	require.Nil(t, err)
	assert.Equal(t, 3102, channel.Id)
	assert.Equal(t, "default", group)
}

func TestRequestedChannelRejectsUnavailableWithoutFallback(t *testing.T) {
	for _, tc := range []struct {
		name      string
		channelID int
		group     string
		modelName string
		filter    *dto.ChannelFilter
	}{
		{name: "missing", channelID: 3999, group: "default", modelName: "selected-model"},
		{name: "disabled", channelID: 3102, group: "default", modelName: "selected-model"},
		{name: "group mismatch", channelID: 3101, group: "vip", modelName: "selected-model"},
		{name: "model mismatch", channelID: 3101, group: "default", modelName: "other-model"},
		{name: "plugin mismatch", channelID: 3101, group: "default", modelName: "selected-model", filter: &dto.ChannelFilter{Kind: dto.FilterTaskPluginIdentity, TaskPluginKey: "unbound-plugin"}},
		{name: "websocket mismatch", channelID: 3101, group: "default", modelName: "selected-model", filter: &dto.ChannelFilter{Kind: dto.FilterResponsesWebSocket}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupChannelSelectAutoGroupsTest(t)
			createChannelSelectAutoGroupsChannel(t, db, 3101, "default", "selected-model")
			createChannelSelectAutoGroupsChannel(t, db, 3102, "default", "selected-model")
			createChannelSelectAutoGroupsChannel(t, db, 3103, "vip", "other-model")
			require.NoError(t, db.Model(&model.Channel{}).Where("id = ?", 3102).Update("status", common.ChannelStatusManuallyDisabled).Error)
			model.InitChannelCache()
			c := newRequestAutoGroupsContext()
			common.SetContextKey(c, constant.ContextKeyUserGroup, "default")
			constraints := GetChannelConstraints(c)
			constraints.RequestedChannelID = tc.channelID
			if tc.filter != nil {
				constraints.AddFilter(*tc.filter)
			}

			channel, group, err := SelectChannelForRequest(c, tc.modelName, &RetryParam{Ctx: c, TokenGroup: tc.group})
			require.NotNil(t, err)
			assert.Equal(t, http.StatusForbidden, err.StatusCode)
			assert.Equal(t, "requested_channel_unavailable", err.Message)
			assert.Nil(t, err.Channel, "rejections must not disclose channel metadata")
			assert.Nil(t, channel)
			assert.Empty(t, group)
			assert.Empty(t, constraints.RequestedChannelGroup)
		})
	}
}

func TestRequestedChannelChecksEveryPinBeforePriorityResolution(t *testing.T) {
	c := newRequestAutoGroupsContext()
	constraints := GetChannelConstraints(c)
	constraints.RequestedChannelID = 3101
	constraints.AddPin(dto.ChannelPin{ChannelId: 3101, Source: dto.PinSourceToken, Rank: dto.PinRankToken})
	constraints.AddPin(dto.ChannelPin{ChannelId: 3102, Source: dto.PinSourceOriginTask, Rank: dto.PinRankOriginTask})

	channel, group, err := SelectChannelForRequest(c, "selected-model", &RetryParam{Ctx: c, TokenGroup: "default"})
	require.NotNil(t, err)
	assert.Equal(t, http.StatusBadRequest, err.StatusCode)
	assert.Equal(t, "requested_channel_conflict", err.Message)
	assert.Nil(t, channel)
	assert.Empty(t, group)
}

func TestRequestedChannelAlwaysEnforcesTokenModelLimits(t *testing.T) {
	db := setupChannelSelectAutoGroupsTest(t)
	createChannelSelectAutoGroupsChannel(t, db, 3101, "default", "selected-model")
	model.InitChannelCache()
	for _, tc := range []struct {
		name    string
		limit   any
		allowed bool
	}{
		{name: "missing limit"},
		{name: "malformed limit", limit: []string{"selected-model"}},
		{name: "empty limit", limit: map[string]bool{}},
		{name: "denied model", limit: map[string]bool{"other-model": true}},
		{name: "explicit false", limit: map[string]bool{"selected-model": false}},
		{name: "allowed model", limit: map[string]bool{"selected-model": true}, allowed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newRequestAutoGroupsContext()
			common.SetContextKey(c, constant.ContextKeyUserGroup, "default")
			common.SetContextKey(c, constant.ContextKeyTokenModelLimitEnabled, true)
			if tc.limit != nil {
				common.SetContextKey(c, constant.ContextKeyTokenModelLimit, tc.limit)
			}
			constraints := GetChannelConstraints(c)
			constraints.RequestedChannelID = 3101
			constraints.AddPin(dto.ChannelPin{ChannelId: 3101, Source: dto.PinSourceToken, Rank: dto.PinRankToken})
			channel, _, err := SelectChannelForRequest(c, "selected-model", &RetryParam{Ctx: c, TokenGroup: "default"})
			if tc.allowed {
				require.Nil(t, err)
				assert.Equal(t, 3101, channel.Id)
			} else {
				require.NotNil(t, err)
				assert.Equal(t, http.StatusForbidden, err.StatusCode)
				assert.Nil(t, channel)
			}
		})
	}
}

func TestRequestedChannelAutoGroupRemainsFrozenAndRechecksPermission(t *testing.T) {
	db := setupChannelSelectAutoGroupsTest(t)
	createChannelSelectAutoGroupsChannel(t, db, 3101, "default", "selected-model")
	require.NoError(t, db.Model(&model.Channel{}).Where("id = ?", 3101).Update("group", "default,vip").Error)
	require.NoError(t, db.Create(&model.Ability{Group: "vip", Model: "selected-model", ChannelId: 3101, Enabled: true}).Error)
	model.InitChannelCache()
	c := newRequestAutoGroupsContext()
	common.SetContextKey(c, constant.ContextKeyUserGroup, "default")
	common.SetContextKey(c, constant.ContextKeyTokenAutoGroups, []string{"vip", "default"})
	constraints := GetChannelConstraints(c)
	constraints.RequestedChannelID = 3101
	param := &RetryParam{Ctx: c, TokenGroup: "auto"}

	channel, group, err := SelectChannelForRequest(c, "selected-model", param)
	require.Nil(t, err)
	assert.Equal(t, 3101, channel.Id)
	assert.Equal(t, "vip", group)
	assert.Equal(t, "vip", common.GetContextKeyString(c, constant.ContextKeyAutoGroup))
	assert.Empty(t, setting.GetAutoGroups(), "explicit token groups must work without a global auto list")

	common.SetContextKey(c, constant.ContextKeyTokenAutoGroups, []string{"default", "vip"})
	channel, group, err = SelectChannelForRequest(c, "selected-model", param)
	require.Nil(t, err)
	assert.Equal(t, 3101, channel.Id)
	assert.Equal(t, "vip", group, "reordering candidates must not change the billing group")

	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default"}`))
	channel, group, err = SelectChannelForRequest(c, "selected-model", param)
	require.NotNil(t, err)
	assert.Equal(t, http.StatusForbidden, err.StatusCode)
	assert.Nil(t, channel)
	assert.Empty(t, group)
	assert.Equal(t, "vip", constraints.RequestedChannelGroup, "permission revocation must not fall back to default")
}

func TestRequestedChannelAutoGroupEmptySnapshotDoesNotFallBack(t *testing.T) {
	db := setupChannelSelectAutoGroupsTest(t)
	createChannelSelectAutoGroupsChannel(t, db, 3101, "default", "selected-model")
	model.InitChannelCache()
	require.NoError(t, setting.UpdateAutoGroupsByJsonString(`["default"]`))
	c := newRequestAutoGroupsContext()
	common.SetContextKey(c, constant.ContextKeyUserGroup, "default")
	common.SetContextKey(c, constant.ContextKeyTokenAutoGroups, []string{})
	GetChannelConstraints(c).RequestedChannelID = 3101

	channel, _, err := SelectChannelForRequest(c, "selected-model", &RetryParam{Ctx: c, TokenGroup: "auto"})
	require.NotNil(t, err)
	assert.Equal(t, http.StatusForbidden, err.StatusCode)
	assert.Nil(t, channel)
}

func TestRequestedChannelReentryRejectsGroupOrModelChanges(t *testing.T) {
	db := setupChannelSelectAutoGroupsTest(t)
	createChannelSelectAutoGroupsChannel(t, db, 3101, "default", "selected-model")
	model.InitChannelCache()
	c := newRequestAutoGroupsContext()
	common.SetContextKey(c, constant.ContextKeyUserGroup, "default")
	constraints := GetChannelConstraints(c)
	constraints.RequestedChannelID = 3101
	param := &RetryParam{Ctx: c, TokenGroup: "default"}
	_, _, err := SelectChannelForRequest(c, "selected-model", param)
	require.Nil(t, err)

	param.TokenGroup = "vip"
	channel, _, err := SelectChannelForRequest(c, "selected-model", param)
	require.NotNil(t, err)
	assert.Nil(t, channel)
	assert.Equal(t, "default", constraints.RequestedChannelGroup)

	param.TokenGroup = "default"
	channel, _, err = SelectChannelForRequest(c, "different-decoded-model", param)
	require.NotNil(t, err)
	assert.Nil(t, channel)

	model.CacheUpdateChannelStatus(3101, common.ChannelStatusManuallyDisabled)
	channel, _, err = SelectChannelForRequest(c, "selected-model", param)
	require.NotNil(t, err)
	assert.Nil(t, channel)
}

func TestNoRequestedChannelPreservesLegacyPinBehavior(t *testing.T) {
	db := setupChannelSelectAutoGroupsTest(t)
	createChannelSelectAutoGroupsChannel(t, db, 3101, "default", "selected-model")
	model.InitChannelCache()
	c := newRequestAutoGroupsContext()
	constraints := GetChannelConstraints(c)
	constraints.AddPin(dto.ChannelPin{ChannelId: 3101, Source: dto.PinSourceToken, Rank: dto.PinRankToken, RetryMode: dto.PinRetrySingleAttempt})
	channel, group, err := SelectChannelForRequest(c, "selected-model", &RetryParam{Ctx: c, TokenGroup: "legacy-admin-group"})
	require.Nil(t, err)
	assert.Equal(t, 3101, channel.Id)
	assert.Empty(t, group)
	assert.True(t, constraints.SuppressesRetry())
	assert.False(t, (&dto.ChannelConstraints{}).SuppressesRetry())
	assert.False(t, (*dto.ChannelConstraints)(nil).SuppressesRetry())
}

func TestConsumeRequestedChannelHeaderStrictParsingAndRemoval(t *testing.T) {
	for _, tc := range []struct {
		name      string
		headers   http.Header
		present   bool
		wantID    int
		wantError bool
	}{
		{name: "absent"},
		{name: "valid", headers: http.Header{constant.ChannelSelectionHeader: {"17"}}, present: true, wantID: 17},
		{name: "lowercase", headers: http.Header{"x-new-api-channel-id": {"17"}}, present: true, wantID: 17},
		{name: "empty value", headers: http.Header{constant.ChannelSelectionHeader: {""}}, present: true, wantError: true},
		{name: "empty entries", headers: http.Header{constant.ChannelSelectionHeader: nil}, present: true, wantError: true},
		{name: "duplicate values", headers: http.Header{constant.ChannelSelectionHeader: {"17", "17"}}, present: true, wantError: true},
		{name: "duplicate spelling", headers: http.Header{constant.ChannelSelectionHeader: {"17"}, "x-new-api-channel-id": {"17"}}, present: true, wantError: true},
		{name: "empty duplicate spelling", headers: http.Header{constant.ChannelSelectionHeader: {"17"}, "x-new-api-channel-id": nil}, present: true, wantError: true},
		{name: "comma list", headers: http.Header{constant.ChannelSelectionHeader: {"17,18"}}, present: true, wantError: true},
		{name: "zero", headers: http.Header{constant.ChannelSelectionHeader: {"0"}}, present: true, wantError: true},
		{name: "negative", headers: http.Header{constant.ChannelSelectionHeader: {"-17"}}, present: true, wantError: true},
		{name: "plus sign", headers: http.Header{constant.ChannelSelectionHeader: {"+17"}}, present: true, wantError: true},
		{name: "leading zero", headers: http.Header{constant.ChannelSelectionHeader: {"017"}}, present: true, wantError: true},
		{name: "whitespace", headers: http.Header{constant.ChannelSelectionHeader: {" 17"}}, present: true, wantError: true},
		{name: "integer overflow", headers: http.Header{constant.ChannelSelectionHeader: {"999999999999999999999999999999"}}, present: true, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newRequestAutoGroupsContext()
			c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/task-1", nil)
			c.Request.Header = tc.headers.Clone()
			present, err := ConsumeRequestedChannelHeader(c)
			assert.Equal(t, tc.present, present)
			if tc.wantError {
				assert.ErrorIs(t, err, ErrInvalidRequestedChannelHeader)
			} else {
				require.NoError(t, err)
			}
			assert.Equal(t, tc.wantID, GetChannelConstraints(c).RequestedChannelID)
			assert.Empty(t, c.Request.Header, "even rejected selection headers must be removed")
		})
	}
}

func TestConsumeRequestedChannelHeaderPreservesExistingSelection(t *testing.T) {
	c := newRequestAutoGroupsContext()
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/task-1", nil)
	constraints := GetChannelConstraints(c)
	constraints.RequestedChannelID = 17
	constraints.RequestedChannelGroup = "historical-group"
	present, err := ConsumeRequestedChannelHeader(c)
	require.NoError(t, err)
	assert.False(t, present)
	assert.Equal(t, 17, constraints.RequestedChannelID)

	c.Request.Header.Set(constant.ChannelSelectionHeader, "17")
	present, err = ConsumeRequestedChannelHeader(c)
	require.NoError(t, err)
	assert.True(t, present)
	c.Request.Header.Set(constant.ChannelSelectionHeader, "18")
	present, err = ConsumeRequestedChannelHeader(c)
	assert.ErrorIs(t, err, ErrInvalidRequestedChannelHeader)
	assert.True(t, present)
	assert.Equal(t, 17, constraints.RequestedChannelID)
	assert.Equal(t, "historical-group", constraints.RequestedChannelGroup)
}

func TestRequestedTaskChannelChecksOnlyHistoricalTaskConsistency(t *testing.T) {
	c := newRequestAutoGroupsContext()
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/task-1", nil)
	common.SetContextKey(c, constant.ContextKeyTokenModelLimitEnabled, true)
	common.SetContextKey(c, constant.ContextKeyTokenModelLimit, map[string]bool{})
	common.SetContextKey(c, constant.ContextKeyUsingGroup, "retired-group")
	common.SetContextKey(c, constant.ContextKeyTokenAutoGroups, []string{})
	require.NoError(t, CheckRequestedTaskChannel(c, 17), "absence must not add new task authorization rules")
	c.Request.Header.Set(constant.ChannelSelectionHeader, "17")
	require.NoError(t, CheckRequestedTaskChannel(c, 17), "historical tasks do not require a current channel/model/group")
	assert.ErrorIs(t, CheckRequestedTaskChannel(c, 18), ErrRequestedTaskChannelMismatch)
	assert.Equal(t, 17, GetChannelConstraints(c).RequestedChannelID)
	assert.Empty(t, GetChannelConstraints(c).RequestedChannelGroup)
}
