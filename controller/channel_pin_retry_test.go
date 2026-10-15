package controller

import (
	"errors"
	"fmt"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestShouldRetryHonorsPinRetryMode(t *testing.T) {
	openaiErr := types.NewOpenAIError(errors.New("upstream"), types.ErrorCodeBadResponseStatusCode, http.StatusInternalServerError)

	c := newPinRetryContext()
	assert.True(t, service.ShouldRetryRelayError(c, openaiErr, 1))

	origin := newPinRetryContext()
	service.GetChannelConstraints(origin).AddPin(dto.ChannelPin{
		ChannelId: 2,
		Source:    dto.PinSourceOriginTask,
		Rank:      dto.PinRankOriginTask,
		RetryMode: dto.PinRetrySameChannel,
	})
	assert.True(t, service.ShouldRetryRelayError(origin, openaiErr, 1), "origin pin retries on the same channel")

	token := newPinRetryContext()
	service.GetChannelConstraints(token).AddPin(dto.ChannelPin{
		ChannelId: 1,
		Source:    dto.PinSourceToken,
		Rank:      dto.PinRankToken,
		RetryMode: dto.PinRetrySingleAttempt,
	})
	assert.Equal(t, service.PolicyDecision{Action: "stop", Reason: "pinned_channel", Source: "channel_constraint"}, service.DecideRelayRetry(token, openaiErr, 1), "token pin suppresses retry")
}

func TestShouldRetryTaskRelayHonorsPinRetryMode(t *testing.T) {
	taskErr := &dto.TaskError{StatusCode: http.StatusInternalServerError}

	c := newPinRetryContext()
	assert.Equal(t, "retry", decideTaskRetry(c, taskErr, 1).Action)

	origin := newPinRetryContext()
	service.GetChannelConstraints(origin).AddPin(dto.ChannelPin{
		ChannelId: 2,
		Source:    dto.PinSourceOriginTask,
		Rank:      dto.PinRankOriginTask,
		RetryMode: dto.PinRetrySameChannel,
	})
	assert.Equal(t, "retry", decideTaskRetry(origin, taskErr, 1).Action)

	token := newPinRetryContext()
	service.GetChannelConstraints(token).AddPin(dto.ChannelPin{
		ChannelId: 1,
		Source:    dto.PinSourceToken,
		Rank:      dto.PinRankToken,
		RetryMode: dto.PinRetrySingleAttempt,
	})
	assert.Equal(t, service.PolicyDecision{Action: "stop", Reason: "pinned_channel", Source: "channel_constraint"}, decideTaskRetry(token, taskErr, 1))
}

func TestSameChannelPinsMergeToStricterRetryMode(t *testing.T) {
	c := newPinRetryContext()
	constraints := service.GetChannelConstraints(c)
	constraints.AddPin(dto.ChannelPin{
		ChannelId: 7,
		Source:    dto.PinSourceOriginTask,
		Rank:      dto.PinRankOriginTask,
		RetryMode: dto.PinRetrySameChannel,
	})
	constraints.AddPin(dto.ChannelPin{
		ChannelId: 7,
		Source:    dto.PinSourceToken,
		Rank:      dto.PinRankToken,
		RetryMode: dto.PinRetrySingleAttempt,
	})
	pin, found, overridden := constraints.ResolvedPin()
	require.True(t, found)
	assert.Equal(t, 7, pin.ChannelId)
	assert.Equal(t, dto.PinRetrySingleAttempt, pin.RetryMode)
	assert.Empty(t, overridden)
	assert.False(t, service.ShouldRetryRelayError(c, types.NewOpenAIError(errors.New("upstream"), types.ErrorCodeBadResponseStatusCode, http.StatusInternalServerError), 1))
}

func newPinRetryContext() *gin.Context {
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	return c
}

func setupRequestedChannelRetryTest(t *testing.T) (*gin.Context, *relaycommon.RelayInfo) {
	t.Helper()
	require.NoError(t, i18n.Init())
	t.Setenv("TEST_TASK_DB_DIALECT", "sqlite")
	database, _ := openTaskDialectDatabase(t, &model.Channel{}, &model.Ability{})
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	previousMaster, previousRedis, previousCache := common.IsMasterNode, common.RedisEnabled, common.MemoryCacheEnabled
	model.DB = database
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	common.IsMasterNode, common.RedisEnabled, common.MemoryCacheEnabled = false, false, false
	t.Setenv("LOG_SQL_DSN", "")
	previousGroups := setting.UserUsableGroups2JSONString()
	previousRatios := ratio_setting.GroupRatio2JSONString()
	// Reuse the isolated connection and initialize the host's quoted SQL names;
	// this performs no migrations or connection to a configured external DB.
	require.NoError(t, model.InitLogDB())
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default"}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1}`))
	t.Cleanup(func() {
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(previousGroups))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(previousRatios))
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.IsMasterNode, common.RedisEnabled, common.MemoryCacheEnabled = previousMaster, previousRedis, previousCache
	})
	channels := []model.Channel{
		{Id: 1, Name: "requested", Type: constant.ChannelTypeOpenAI, Status: common.ChannelStatusEnabled, Models: "requested-model", Group: "default"},
		{Id: 2, Name: "other", Type: constant.ChannelTypeOpenAI, Status: common.ChannelStatusEnabled, Models: "requested-model", Group: "default"},
	}
	for i := range channels {
		require.NoError(t, model.DB.Create(&channels[i]).Error)
		require.NoError(t, channels[i].AddAbilities(model.DB))
	}
	c := newPinRetryContext()
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", strings.NewReader(`{"model":"requested-model"}`))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Request.Header.Set(constant.ChannelSelectionHeader, "1")
	require.NoError(t, middleware.SetupContextForToken(c, &model.Token{
		Id: 1, UserId: 1, Group: "default", ModelLimitsEnabled: true, ModelLimits: "requested-model",
	}))
	common.SetContextKey(c, constant.ContextKeyUsingGroup, "default")
	common.SetContextKey(c, constant.ContextKeyUserGroup, "default")
	// Stale preselection and locked task metadata must never override the Header.
	common.SetContextKey(c, constant.ContextKeyChannelId, 2)
	common.SetContextKey(c, constant.ContextKeyChannelType, constant.ChannelTypeOpenAI)
	return c, &relaycommon.RelayInfo{
		UserId: 1, UserGroup: "default", TokenGroup: "default", UsingGroup: "default", OriginModelName: "requested-model",
		TaskRelayInfo: &relaycommon.TaskRelayInfo{LockedChannel: &channels[1]},
	}
}

func TestRequestedChannelGetChannelRevalidatesEveryPhase(t *testing.T) {
	for _, initialized := range []bool{false, true} {
		t.Run(fmt.Sprintf("channel_meta=%t", initialized), func(t *testing.T) {
			c, info := setupRequestedChannelRetryTest(t)
			if initialized {
				info.ChannelMeta = &relaycommon.ChannelMeta{ChannelId: 2, ChannelType: constant.ChannelTypeOpenAI}
			}
			retry := &service.RetryParam{Ctx: c, TokenGroup: "default", ModelName: "requested-model"}
			for attempt := 0; attempt < 2; attempt++ {
				channel, channelErr := getChannel(c, info, retry)
				require.Nil(t, channelErr)
				require.NotNil(t, channel)
				assert.Equal(t, 1, channel.Id)
				assert.Equal(t, 1, common.GetContextKeyInt(c, constant.ContextKeyChannelId))
				assert.Equal(t, "default", service.GetChannelConstraints(c).RequestedChannelGroup)
				retry.IncreaseRetry()
			}
			assert.Equal(t, 2, service.RequestPolicy(c).Attempts)
			// Keep channel 2 usable: a fallback would succeed and expose the bypass.
			require.NoError(t, model.DB.Model(&model.Ability{}).Where("channel_id = ?", 1).Update("enabled", false).Error)
			require.True(t, model.IsChannelEnabledForGroupModel("default", "requested-model", 2))
			channel, channelErr := getChannel(c, info, retry)
			assert.Nil(t, channel)
			require.NotNil(t, channelErr)
			assert.Equal(t, http.StatusForbidden, channelErr.StatusCode)
			assert.Equal(t, types.ErrorCodeAccessDenied, channelErr.GetErrorCode())
			assert.Equal(t, i18n.T(c, i18n.MsgRequestedChannelUnavailable), channelErr.Error())
			assert.False(t, service.ShouldRetryRelayError(c, channelErr, 3))
			assert.Equal(t, 2, service.RequestPolicy(c).Attempts, "rejected selection must not start an attempt")
			assert.Equal(t, 1, common.GetContextKeyInt(c, constant.ContextKeyChannelId), "must not switch to the still-eligible channel")
		})
	}
}

func TestRequestedChannelTaskSubmissionCannotUseLockedShortcut(t *testing.T) {
	previousRetryTimes := common.RetryTimes
	common.RetryTimes = 3
	t.Cleanup(func() { common.RetryTimes = previousRetryTimes })
	for _, revoked := range []bool{false, true} {
		t.Run(fmt.Sprintf("permission_revoked=%t", revoked), func(t *testing.T) {
			c, info := setupRequestedChannelRetryTest(t)
			info.ChannelMeta = &relaycommon.ChannelMeta{ChannelId: 2, ChannelType: constant.ChannelTypeOpenAI}
			if revoked {
				require.NoError(t, model.DB.Model(&model.Ability{}).Where("channel_id = ?", 1).Update("enabled", false).Error)
			}
			var attemptedChannels []int
			outcome, taskErr := executeTaskSubmissionWith(c, info, func(ctx *gin.Context, _ *relaycommon.RelayInfo) (*relay.TaskSubmitResult, *dto.TaskError) {
				attemptedChannels = append(attemptedChannels, common.GetContextKeyInt(ctx, constant.ContextKeyChannelId))
				return nil, &dto.TaskError{StatusCode: http.StatusServiceUnavailable, LocalError: true, Message: "test retryable failure"}
			})
			assert.Nil(t, outcome)
			require.NotNil(t, taskErr)
			if revoked {
				assert.Equal(t, http.StatusForbidden, taskErr.StatusCode)
				assert.Empty(t, attemptedChannels, "revocation must stop before the locked submit callback")
				assert.Zero(t, service.RequestPolicy(c).Attempts)
			} else {
				assert.Equal(t, http.StatusServiceUnavailable, taskErr.StatusCode)
				assert.Equal(t, []int{1}, attemptedChannels, "Header selection permits exactly one attempt on the requested channel")
				assert.Equal(t, []string{"1"}, c.GetStringSlice("use_channel"))
				assert.Equal(t, 1, service.RequestPolicy(c).Attempts)
			}
		})
	}
}

func TestRequestedChannelSuppressesRelayAndTaskRetries(t *testing.T) {
	for _, status := range []int{http.StatusTemporaryRedirect, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusServiceUnavailable} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			c := newPinRetryContext()
			c.Request.Header.Set(constant.ChannelSelectionHeader, "1")
			require.NoError(t, middleware.SetupContextForToken(c, &model.Token{Id: 1, UserId: 1, Group: "default"}))
			want := service.PolicyDecision{Action: "stop", Reason: "pinned_channel", Source: "channel_constraint"}
			relayErr := types.NewOpenAIError(errors.New("retryable failure"), types.ErrorCodeBadResponseStatusCode, status)
			assert.Equal(t, want, service.DecideRelayRetry(c, relayErr, 3))
			assert.Equal(t, want, decideTaskRetry(c, &dto.TaskError{StatusCode: status}, 3))
		})
	}
}

func TestRequestPolicyConfigReturnsSettingsWithoutMigration(t *testing.T) {
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	GetRequestPolicy(ctx)
	assert.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool           `json:"success"`
		Data    map[string]any `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.True(t, response.Success)
	assert.Contains(t, response.Data, "options")
	assert.NotContains(t, response.Data, "migration")
	assert.NotContains(t, response.Data, "differences")
}

func TestRequestPolicyRoutingDatabaseMatrix(t *testing.T) {
	require.NoError(t, i18n.Init())
	for _, dialect := range []struct{ kind, env string }{{"sqlite", ""}, {"mysql", "TEST_MYSQL_DSN"}, {"postgres", "TEST_POSTGRES_DSN"}} {
		t.Run(dialect.kind, func(t *testing.T) {
			dsn := ""
			if dialect.env != "" {
				dsn = os.Getenv(dialect.env)
				if dsn == "" {
					t.Skipf("%s not configured", dialect.env)
				}
			}
			db := modelManagementDB(t, dialect.kind, dsn)
			previousGroups := setting.UserUsableGroups2JSONString()
			previousRatios, err := common.Marshal(ratio_setting.GetGroupRatioCopy())
			require.NoError(t, err)
			require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default"}`))
			require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1}`))
			t.Cleanup(func() {
				require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(previousGroups))
				require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(string(previousRatios)))
			})
			// Channel 1 holds the session binding but is no longer usable.
			channels := []model.Channel{
				{Id: 1, Name: "A", Type: 1, Key: "test-only", Status: common.ChannelStatusAutoDisabled, Models: "policy-test", Group: "default", Priority: common.GetPointer(int64(10))},
				{Id: 2, Name: "B", Type: 1, Key: "test-only", Status: common.ChannelStatusEnabled, Models: "policy-test", Group: "default", Priority: common.GetPointer(int64(5))},
			}
			for i := range channels {
				require.NoError(t, db.Create(&channels[i]).Error)
				require.NoError(t, channels[i].AddAbilities(db))
			}
			affinity := operation_setting.GetChannelAffinitySetting()
			previousAffinity := *affinity
			t.Cleanup(func() { *affinity = previousAffinity })
			for _, cached := range []bool{false, true} {
				for _, keep := range []bool{false, true} {
					for _, tc := range []struct {
						globalMode, ruleMode string
						blocked              bool
					}{
						{"strict", "inherit", true},
						{"prefer", "strict", true},
						{"prefer", "inherit", false},
						{"strict", "prefer", false},
					} {
						t.Run(fmt.Sprintf("cache=%t/keep=%t/global=%s/rule=%s", cached, keep, tc.globalMode, tc.ruleMode), func(t *testing.T) {
							common.MemoryCacheEnabled = cached
							model.InitChannelCache()
							snapshot, err := model.BuildRequestPolicy(map[string]string{
								"channel_affinity_setting.enabled":                  "true",
								"channel_affinity_setting.session_mode":             tc.globalMode,
								"channel_affinity_setting.keep_on_channel_disabled": fmt.Sprint(keep),
								"channel_affinity_setting.rules":                    fmt.Sprintf(`[{"name":"session","model_regex":[".*"],"key_sources":[{"type":"request_header","key":"X-Session"}],"session_mode":%q}]`, tc.ruleMode),
							})
							require.NoError(t, err)
							*affinity = snapshot.Affinity
							seed := newPinRetryContext()
							seed.Request.Header.Set("X-Session", t.Name())
							_, found := service.GetPreferredChannelByAffinity(seed, "policy-test", "default")
							require.False(t, found)
							seed.Set("channel_id", 1)
							service.RecordChannelAffinity(seed, 1)
							t.Cleanup(func() { service.ClearCurrentChannelAffinityCache(seed) })
							bound, found := service.GetPreferredChannelByAffinity(seed, "policy-test", "default")
							require.True(t, found)
							require.Equal(t, 1, bound)

							request := newPinRetryContext()
							request.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"policy-test"}`))
							request.Request.Header.Set("Content-Type", "application/json")
							request.Request.Header.Set("X-Session", t.Name())
							common.SetContextKey(request, constant.ContextKeyUsingGroup, "default")
							middleware.Distribute()(request)
							events := service.RequestPolicy(request).Events()
							assert.True(t, slices.ContainsFunc(events, func(event service.PolicyEvent) bool { return event.Decision.Reason == "session_rule_matched" }), "decision events are recorded for every request")
							bound, found = service.GetPreferredChannelByAffinity(seed, "policy-test", "default")
							if tc.blocked {
								assert.Equal(t, http.StatusServiceUnavailable, request.Writer.Status())
								assert.True(t, request.IsAborted())
								assert.Equal(t, keep, found, "binding retention is independent of strict request handling")
								if found {
									assert.Equal(t, 1, bound)
								}
								return
							}
							assert.False(t, request.IsAborted())
							assert.Equal(t, 2, common.GetContextKeyInt(request, constant.ContextKeyChannelId), "prefer falls back to the next eligible channel")
							require.True(t, found)
							assert.Equal(t, 2, bound, "a successful fallback rebinds the session")
						})
					}
				}
			}
		})
	}
}
