package controller

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestTaskPluginDiscoveryVerifiedContract(t *testing.T) {
	meta := jsplugin.Meta{APIVersion: 1, Key: "discovery-test", Name: "Discovery", Version: "1.0.0", Author: jsplugin.AuthorMeta{Name: "Test"}, Models: []string{"known"}, FetchMode: "per_task", ModelDiscovery: &jsplugin.ModelDiscovery{Path: "/v1/models", Format: "openai", SourceURL: "https://docs.example/models", SourceSHA256: strings.Repeat("a", 64)}}
	require.NoError(t, jsplugin.ValidateV1Meta(meta))
	for _, tc := range []struct {
		name, body string
		status     int
		want       []string
		fail       string
	}{
		{"real list", `{"data":[{"id":"known"},{"id":"new"},{"id":"known"}]}`, 200, []string{"known", "new"}, ""},
		{"empty list", `{"data":[]}`, 200, []string{}, ""},
		{"missing list", `{"error":"secret-fixture"}`, 200, nil, "invalid model list"},
		{"malformed", `{"data":`, 200, nil, "invalid model list"},
		{"unauthorized", `secret-fixture`, 401, nil, "HTTP 401"},
		{"forbidden", `secret-fixture`, 403, nil, "HTTP 403"},
		{"unavailable", `secret-fixture`, 503, nil, "HTTP 503"},
		{"oversized", strings.Repeat("x", (1<<20)+1), 200, nil, "too large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				assert.Equal(t, http.MethodGet, r.Method)
				assert.Equal(t, "/v1/models", r.URL.Path)
				assert.Equal(t, "Bearer secret-fixture", r.Header.Get("Authorization"))
				assert.Empty(t, r.Header.Get(constant.ChannelSelectionHeader))
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			base := server.URL + "/v1/"
			channel := &model.Channel{Type: constant.ChannelTypeTaskPlugin, Key: "secret-fixture", BaseURL: &base}
			ids, err := fetchTaskPluginUpstreamModels(channel, meta)
			if tc.fail != "" {
				require.ErrorContains(t, err, tc.fail)
				assert.NotContains(t, err.Error(), "secret-fixture")
				assert.Nil(t, ids)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tc.want, ids)
			}
			assert.Equal(t, 1, calls)
		})
	}
	meta.ModelDiscovery = nil
	_, err := fetchTaskPluginUpstreamModels(&model.Channel{}, meta)
	require.ErrorContains(t, err, "no verified upstream model-list endpoint")
}

func TestTaskPluginDiscoveryRejectsRedirectAndUnsafeDeclarations(t *testing.T) {
	meta := jsplugin.Meta{APIVersion: 1, Key: "discovery-test", Name: "Discovery", Version: "1.0.0", Author: jsplugin.AuthorMeta{Name: "Test"}, Models: []string{"known"}, FetchMode: "per_task", ModelDiscovery: &jsplugin.ModelDiscovery{Path: "/v1/models", Format: "openai", SourceURL: "https://docs.example/models", SourceSHA256: strings.Repeat("a", 64)}}
	for _, path := range []string{"//attacker.example/models", "https://attacker.example/models", "/../models", "/v1/models?key=x", "/v1/%2e%2e/models", "/v1\\models", "/v1//models"} {
		candidate := meta
		discovery := *meta.ModelDiscovery
		discovery.Path = path
		candidate.ModelDiscovery = &discovery
		require.Error(t, jsplugin.ValidateV1Meta(candidate), path)
	}
	targetCalls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls++ }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer source.Close()
	channel := &model.Channel{Type: constant.ChannelTypeTaskPlugin, Key: "secret-fixture", BaseURL: &source.URL}
	_, err := fetchTaskPluginUpstreamModels(channel, meta)
	require.ErrorContains(t, err, "HTTP 307")
	assert.Zero(t, targetCalls)
}

func TestFenglangPricingDiscovery(t *testing.T) {
	meta := jsplugin.Meta{APIVersion: 1, Key: "fenglang_video", Name: "Fenglang", Version: "2.1.0", Author: jsplugin.AuthorMeta{Name: "Test"}, Models: []string{"seedance-2.5"}, FetchMode: "per_task", ModelDiscovery: &jsplugin.ModelDiscovery{Path: "/pricing", Format: "fenglang_pricing", SourceURL: "https://fenglang.cloud/js/openapi.js", SourceSHA256: strings.Repeat("a", 64)}}
	for _, tc := range []struct {
		name, body string
		status     int
		want       []string
		fail       string
	}{
		{"objects exclude images and prices", `{"success":true,"models":{"video":[{"id":"actual","price":123},{"id":"actual"}],"image":[{"id":"image-only"}]}}`, 200, []string{"actual"}, ""},
		{"strings", `{"success":true,"models":{"video":["actual-new"]}}`, 200, []string{"actual-new"}, ""},
		{"empty", `{"success":true,"models":{"video":[]}}`, 200, []string{}, ""},
		{"missing", `{"success":true,"data":[{"id":"wrong"}]}`, 200, nil, "invalid model list"},
		{"null", `{"success":true,"models":{"video":null}}`, 200, nil, "invalid model list"},
		{"failure", `{"success":false,"models":{"video":["unsafe"]},"message":"secret-fixture"}`, 200, nil, "invalid model list"},
		{"unrecognized model field", `{"success":true,"models":{"video":[{"model":"guess"}]}}`, 200, nil, "invalid model list"},
		{"blank ID", `{"success":true,"models":{"video":[" "]}}`, 200, nil, "invalid model list"},
		{"unauthorized", `secret-fixture`, 401, nil, "HTTP 401"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				assert.Equal(t, "/open/v1/pricing", r.URL.Path)
				assert.Equal(t, "Bearer secret-fixture", r.Header.Get("Authorization"))
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			base := server.URL + "/open/v1/"
			ids, err := fetchTaskPluginUpstreamModels(&model.Channel{Type: constant.ChannelTypeTaskPlugin, Key: "secret-fixture", BaseURL: &base}, meta)
			if tc.fail != "" {
				require.ErrorContains(t, err, tc.fail)
				assert.NotContains(t, err.Error(), "secret-fixture")
				assert.Nil(t, ids)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tc.want, ids)
			}
			assert.Equal(t, 1, calls)
		})
	}
}

func setupTaskPluginDiscoveryTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousRegistry := jsplugin.DefaultRegistry
	previousCache, previousRedis := common.MemoryCacheEnabled, common.RedisEnabled
	previousMainType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		jsplugin.DefaultRegistry = previousRegistry
		common.MemoryCacheEnabled, common.RedisEnabled = previousCache, previousRedis
		common.SetDatabaseTypes(previousMainType, previousLogType)
	})
	db := setupModelListControllerTestDB(t)
	common.MemoryCacheEnabled = false
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	require.NoError(t, db.AutoMigrate(&model.Log{}, &model.AuditLog{}))
	return db
}

func taskPluginDiscoveryTestSource(t *testing.T, key string, models []string, path, digest string) string {
	t.Helper()
	meta := map[string]any{
		"apiVersion": 1, "key": key, "name": "Discovery fixture", "version": "1.0.0",
		"author": jsplugin.AuthorMeta{Name: "Test"}, "models": models, "fetchMode": "per_task",
		"modelDiscovery": jsplugin.ModelDiscovery{Path: path, Format: "openai", SourceURL: "https://docs.example" + path, SourceSHA256: digest},
	}
	encoded, err := common.Marshal(meta)
	require.NoError(t, err)
	return "export const meta = " + string(encoded) + `;
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {}; }
export function buildQueryRequest() { return {}; }
export function parseTaskResult() { return {}; }
`
}

func TestTaskPluginDiscoveryRejectsBlankKeyWithoutRequest(t *testing.T) {
	meta := jsplugin.Meta{APIVersion: 1, Key: "discovery-test", Name: "Discovery", Version: "1.0.0", Author: jsplugin.AuthorMeta{Name: "Test"}, Models: []string{"known"}, FetchMode: "per_task", ModelDiscovery: &jsplugin.ModelDiscovery{Path: "/v1/models", Format: "openai", SourceURL: "https://docs.example/models", SourceSHA256: strings.Repeat("a", 64)}}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"data":[{"id":"known"}]}`))
	}))
	defer server.Close()
	for _, key := range []string{"", " \t\r\n "} {
		channel := &model.Channel{Type: constant.ChannelTypeTaskPlugin, Key: key, BaseURL: &server.URL}
		ids, err := fetchTaskPluginUpstreamModels(channel, meta)
		require.EqualError(t, err, "No enabled channel key is available for model discovery")
		assert.Nil(t, ids)
	}
	assert.Zero(t, calls)
}

func TestTaskPluginDiscoveryHTTPUsesOneSnapshot(t *testing.T) {
	for _, saved := range []bool{false, true} {
		t.Run(fmt.Sprintf("saved=%t", saved), func(t *testing.T) {
			db := setupTaskPluginDiscoveryTestDB(t)
			const pluginKey = "discovery-snapshot"
			oldHash, newHash := strings.Repeat("a", 64), strings.Repeat("b", 64)
			oldSource := taskPluginDiscoveryTestSource(t, pluginKey, []string{"known"}, "/v1/models", oldHash)
			newSource := taskPluginDiscoveryTestSource(t, pluginKey, []string{"new"}, "/v2/models", newHash)
			_, err := jsplugin.DefaultRegistry.Register(oldSource, jsplugin.Options{})
			require.NoError(t, err)
			reloaded := make(chan error, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, "/v1/models", r.URL.Path)
				_, err := jsplugin.DefaultRegistry.Register(newSource, jsplugin.Options{})
				reloaded <- err
				_, _ = w.Write([]byte(`{"data":[{"id":"known"},{"id":"new"}]}`))
			}))
			defer server.Close()
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			if saved {
				channel := &model.Channel{Type: constant.ChannelTypeTaskPlugin, Key: "fixture", BaseURL: &server.URL, Models: "known"}
				channel.SetSetting(dto.ChannelSettings{TaskPluginKey: pluginKey})
				require.NoError(t, db.Create(channel).Error)
				ctx.Params = gin.Params{{Key: "id", Value: fmt.Sprint(channel.Id)}}
				ctx.Request = httptest.NewRequest(http.MethodGet, "/api/channel/fetch_models/"+fmt.Sprint(channel.Id), nil)
				FetchUpstreamModels(ctx)
			} else {
				body, err := common.Marshal(map[string]any{"type": constant.ChannelTypeTaskPlugin, "key": "fixture", "base_url": server.URL, "task_plugin_key": pluginKey})
				require.NoError(t, err)
				ctx.Request = httptest.NewRequest(http.MethodPost, "/api/channel/fetch_models", bytes.NewReader(body))
				ctx.Request.Header.Set("Content-Type", "application/json")
				FetchModels(ctx)
			}
			select {
			case err := <-reloaded:
				require.NoError(t, err)
			default:
				t.Fatalf("discovery did not reach the upstream fixture: %s", recorder.Body.String())
			}
			var response struct {
				Success   bool     `json:"success"`
				Data      []string `json:"data"`
				Discovery struct {
					SourceURL    string `json:"source_url"`
					SourceSHA256 string `json:"source_sha256"`
					Models       []struct {
						ID         string `json:"id"`
						Adapted    bool   `json:"adapted"`
						Configured bool   `json:"configured"`
					} `json:"models"`
				} `json:"discovery"`
			}
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			require.True(t, response.Success, recorder.Body.String())
			assert.Equal(t, []string{"known", "new"}, response.Data)
			assert.Equal(t, "https://docs.example/v1/models", response.Discovery.SourceURL)
			assert.Equal(t, oldHash, response.Discovery.SourceSHA256)
			require.Len(t, response.Discovery.Models, 2)
			assert.True(t, response.Discovery.Models[0].Adapted)
			assert.Equal(t, saved, response.Discovery.Models[0].Configured)
			assert.False(t, response.Discovery.Models[1].Adapted)
			active, ok := jsplugin.DefaultRegistry.Get(pluginKey)
			require.True(t, ok)
			assert.Equal(t, newHash, active.Meta.ModelDiscovery.SourceSHA256)
		})
	}
}

func TestTaskPluginUpstreamApplyKeepsUnadaptedModelsPending(t *testing.T) {
	for _, applyAll := range []bool{false, true} {
		t.Run(fmt.Sprintf("apply_all=%t", applyAll), func(t *testing.T) {
			db := setupTaskPluginDiscoveryTestDB(t)
			const pluginKey = "discovery-apply"
			source := taskPluginDiscoveryTestSource(t, pluginKey, []string{"known", "mapped", "chain-target", "redirected"}, "/v1/models", strings.Repeat("a", 64))
			_, err := jsplugin.DefaultRegistry.Register(source, jsplugin.Options{})
			require.NoError(t, err)
			foreignSource := taskPluginDiscoveryTestSource(t, "discovery-other", []string{"foreign"}, "/v1/models", strings.Repeat("b", 64))
			_, err = jsplugin.DefaultRegistry.Register(foreignSource, jsplugin.Options{})
			require.NoError(t, err)
			mapping := `{"alias":"mapped","chain":"hop","hop":"chain-target","redirected":"unsupported","cycle":"cycle2","cycle2":"cycle"}`
			pending := []string{"known", "alias", "chain", "new", "foreign", "Known", "redirected", "cycle", "legacy"}
			wantAdded := []string{"known", "alias", "chain", "Known", "legacy"}
			wantRemaining := []string{"new", "foreign", "redirected", "cycle"}
			channels := []*model.Channel{
				{Type: constant.ChannelTypeTaskPlugin, Name: "bound plugin", Models: "legacy", ModelMapping: &mapping},
				{Type: constant.ChannelTypeTaskPlugin, Name: "missing plugin", Models: "legacy"},
				{Type: constant.ChannelTypeOpenAI, Name: "ordinary channel", Models: "legacy"},
			}
			for i, channel := range channels {
				channel.Status, channel.Group = common.ChannelStatusEnabled, "default"
				key := pluginKey
				if i == 1 {
					key = "missing-plugin"
				}
				channel.SetSetting(dto.ChannelSettings{TaskPluginKey: key})
				channel.SetOtherSettings(dto.ChannelOtherSettings{UpstreamModelUpdateCheckEnabled: true, UpstreamModelUpdateLastDetectedModels: pending})
				require.NoError(t, db.Create(channel).Error)
			}
			if applyAll {
				recorder := httptest.NewRecorder()
				ctx, _ := gin.CreateTestContext(recorder)
				ctx.Request = httptest.NewRequest(http.MethodPost, "/api/channel/upstream-models/apply-all", nil)
				ApplyAllChannelUpstreamModelUpdates(ctx)
				var response struct {
					Success bool `json:"success"`
					Data    struct {
						Failed  []int                                       `json:"failed_channel_ids"`
						Results []applyAllChannelUpstreamModelUpdatesResult `json:"results"`
					} `json:"data"`
				}
				require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
				require.True(t, response.Success, recorder.Body.String())
				assert.Empty(t, response.Data.Failed)
				require.Len(t, response.Data.Results, 3)
				assert.Equal(t, wantAdded, response.Data.Results[0].AddedModels)
				assert.Equal(t, wantRemaining, response.Data.Results[0].RemainingModels)
			} else {
				for i, channel := range channels {
					added, _, remaining, _, _, err := applyChannelUpstreamModelUpdates(channel, pending, nil, nil)
					require.NoError(t, err)
					if i == 0 {
						assert.Equal(t, wantAdded, added)
						assert.Equal(t, wantRemaining, remaining)
					}
				}
			}
			for i, channel := range channels {
				saved, err := model.GetChannelById(channel.Id, true)
				require.NoError(t, err)
				switch i {
				case 0:
					assert.Equal(t, []string{"legacy", "known", "alias", "chain", "Known"}, saved.GetModels())
					assert.Equal(t, wantRemaining, saved.GetOtherSettings().UpstreamModelUpdateLastDetectedModels)
				case 1:
					assert.Equal(t, "legacy", saved.Models)
					assert.Equal(t, pending[:len(pending)-1], saved.GetOtherSettings().UpstreamModelUpdateLastDetectedModels)
				case 2:
					assert.ElementsMatch(t, pending, saved.GetModels())
					assert.Empty(t, saved.GetOtherSettings().UpstreamModelUpdateLastDetectedModels)
				}
			}
		})
	}
}

func newAdvancedCustomModelListChannel(baseURL string, key string, upstreamPath string, auth *dto.AdvancedCustomRouteAuth) *model.Channel {
	config := &dto.AdvancedCustomConfig{
		Routes: []dto.AdvancedCustomRoute{
			{
				IncomingPath: dto.AdvancedCustomModelListPath,
				UpstreamPath: upstreamPath,
				Converter:    "none",
				Auth:         auth,
			},
		},
	}
	channel := &model.Channel{
		Type:    constant.ChannelTypeAdvancedCustom,
		Key:     key,
		BaseURL: &baseURL,
	}
	channel.SetOtherSettings(dto.ChannelOtherSettings{AdvancedCustom: config})
	return channel
}

func TestParseOpenAIModelIDsStrictResponseContract(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		want      []string
		wantError string
	}{
		{name: "malformed JSON", body: `{"data":`, wantError: "invalid OpenAI Models response"},
		{name: "missing data", body: `{"object":"list"}`, wantError: "data is required"},
		{name: "null data", body: `{"data":null}`, wantError: "data is required"},
		{name: "empty data", body: `{"data":[]}`, wantError: "no valid model IDs"},
		{name: "all IDs empty", body: `{"data":[{"id":""},{"id":"   "}]}`, wantError: "no valid model IDs"},
		{
			name: "filters empty IDs and normalizes valid IDs",
			body: `{"data":[{"id":" gpt-4.1 "},{"id":""},{"id":"gpt-4.1"},{"id":"o3"}]}`,
			want: []string{"gpt-4.1", "o3"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			models, err := parseOpenAIModelIDs([]byte(test.body))
			if test.wantError != "" {
				require.ErrorContains(t, err, test.wantError)
				require.Nil(t, models)
				return
			}
			require.NoError(t, err)
			require.Equal(t, test.want, models)
		})
	}
}

func TestFetchAdvancedCustomModelsAppliesHeaderOverrideAfterRouteAuth(t *testing.T) {
	type receivedRequest struct {
		Headers http.Header
		Host    string
	}
	received := make(chan receivedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- receivedRequest{Headers: r.Header.Clone(), Host: r.Host}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-4.1"}]}`))
	}))
	defer server.Close()

	channel := newAdvancedCustomModelListChannel(server.URL, "secret-key", "/provider/models", &dto.AdvancedCustomRouteAuth{
		Type:  dto.AdvancedCustomAuthTypeHeader,
		Name:  "X-Route-Key",
		Value: "route-{api_key}",
	})
	headerOverride := `{
		"X-Route-Key":"global-{api_key}",
		"X-Static":"static-value",
		"X-Client":"{client_header:X-Client}",
		"Host":"models.example.test",
		"*":""
	}`
	channel.HeaderOverride = &headerOverride

	models, err := fetchChannelUpstreamModelIDs(channel)
	require.NoError(t, err)
	require.Equal(t, []string{"gpt-4.1"}, models)

	request := <-received
	require.Equal(t, "global-secret-key", request.Headers.Get("X-Route-Key"))
	require.Equal(t, "static-value", request.Headers.Get("X-Static"))
	require.Empty(t, request.Headers.Get("X-Client"))
	require.Equal(t, "models.example.test", request.Host)
}

func TestFetchAdvancedCustomModelsUsesEnabledSavedMultiKey(t *testing.T) {
	authorization := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization <- r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-4.1-mini"}]}`))
	}))
	defer server.Close()

	channel := newAdvancedCustomModelListChannel(server.URL, "disabled-key\nenabled-key", "/v1/models", nil)
	channel.ChannelInfo = model.ChannelInfo{
		IsMultiKey: true,
		MultiKeyStatusList: map[int]int{
			0: common.ChannelStatusManuallyDisabled,
			1: common.ChannelStatusEnabled,
		},
	}

	models, err := fetchChannelUpstreamModelIDs(channel)
	require.NoError(t, err)
	require.Equal(t, []string{"gpt-4.1-mini"}, models)
	require.Equal(t, "Bearer enabled-key", <-authorization)
}

func TestFetchAdvancedCustomModelsRejectsNonOKResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"data":[{"id":"must-not-be-used"}]}`))
	}))
	defer server.Close()

	channel := newAdvancedCustomModelListChannel(server.URL, "secret-key", "/v1/models", nil)
	models, err := fetchChannelUpstreamModelIDs(channel)
	require.ErrorContains(t, err, "status code: 502")
	require.Nil(t, models)
}

func TestFetchAdvancedCustomModelsRedactsQueryKeyFromTransportErrors(t *testing.T) {
	const secret = "secret key/+"
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	baseURL := server.URL
	server.Close()

	channel := newAdvancedCustomModelListChannel(baseURL, secret, "/v1/models", &dto.AdvancedCustomRouteAuth{
		Type:  dto.AdvancedCustomAuthTypeQuery,
		Name:  "custom-token",
		Value: "prefix-{api_key}",
	})

	_, err := fetchChannelUpstreamModelIDs(channel)
	require.Error(t, err)
	require.NotContains(t, err.Error(), secret)
	require.NotContains(t, err.Error(), "custom-token")
	require.NotContains(t, err.Error(), "prefix-")

	direct := sanitizeFetchModelsError(&url.Error{
		Op:  http.MethodGet,
		URL: baseURL + "/v1/models?custom-token=prefix-" + url.QueryEscape(secret),
		Err: errors.New("connection refused"),
	}, secret)
	require.EqualError(t, direct, "connection refused")

	queryValue := "prefix-" + secret
	queryError := sanitizeAdvancedCustomRequestError(
		errors.New("dial "+queryValue+": connection refused"),
		queryValue,
		baseURL+"/v1/models?custom-token="+url.QueryEscape(queryValue),
	)
	require.NotContains(t, queryError.Error(), queryValue)
	require.EqualError(t, queryError, "dial [REDACTED]: connection refused")
}

func TestFetchOrdinaryOpenAIModelsKeepsExistingEmptyDataBehavior(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"object":"list"}`))
	}))
	defer server.Close()

	baseURL := server.URL
	channel := &model.Channel{
		Type:    constant.ChannelTypeOpenAI,
		Key:     "ordinary-key",
		BaseURL: &baseURL,
	}
	models, err := fetchChannelUpstreamModelIDs(channel)
	require.NoError(t, err)
	require.Empty(t, models)
}

func TestFetchModelsAdvancedCustomCreatePreview(t *testing.T) {
	receivedAuthorization := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuthorization <- r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"data":[{"id":"preview-model"}]}`))
	}))
	defer server.Close()

	config := dto.AdvancedCustomConfig{Routes: []dto.AdvancedCustomRoute{{
		IncomingPath: dto.AdvancedCustomModelListPath,
		UpstreamPath: "/preview/models",
		Converter:    "none",
	}}}
	configBytes, err := common.Marshal(config)
	require.NoError(t, err)
	rawConfig := string(configBytes)
	baseURL := server.URL
	emptyProxy := ""
	req := fetchModelsRequest{
		BaseURL:        &baseURL,
		Type:           constant.ChannelTypeAdvancedCustom,
		Key:            "create-preview-key",
		AdvancedCustom: &rawConfig,
		Proxy:          &emptyProxy,
	}
	body, err := common.Marshal(req)
	require.NoError(t, err)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/channel/fetch_models", bytes.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	FetchModels(ctx)

	var response struct {
		Success bool     `json:"success"`
		Message string   `json:"message"`
		Data    []string `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success, response.Message)
	require.Equal(t, []string{"preview-model"}, response.Data)
	require.Equal(t, "Bearer create-preview-key", <-receivedAuthorization)
}

func TestFetchModelsAdvancedCustomEditPreviewUsesSavedKeyAndExplicitClears(t *testing.T) {
	db := setupModelListControllerTestDB(t)
	receivedHeaders := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders <- r.Header.Clone()
		_, _ = w.Write([]byte(`{"data":[{"id":"edited-preview-model"}]}`))
	}))
	defer server.Close()

	savedChannel := newAdvancedCustomModelListChannel("http://127.0.0.1:1", "disabled-saved-key\nenabled-saved-key", "/saved/models", nil)
	savedChannel.Name = "saved advanced channel"
	savedChannel.Models = "old-model"
	savedChannel.ChannelInfo = model.ChannelInfo{
		IsMultiKey: true,
		MultiKeyStatusList: map[int]int{
			0: common.ChannelStatusManuallyDisabled,
			1: common.ChannelStatusEnabled,
		},
	}
	savedHeaderOverride := `{"X-Saved":"must-not-be-sent"}`
	savedChannel.HeaderOverride = &savedHeaderOverride
	savedChannel.SetSetting(dto.ChannelSettings{Proxy: "http://127.0.0.1:1"})
	require.NoError(t, db.Create(savedChannel).Error)

	preserved, err := buildAdvancedCustomModelPreviewChannel(fetchModelsRequest{ChannelID: savedChannel.Id})
	require.NoError(t, err)
	require.Equal(t, "http://127.0.0.1:1", preserved.GetBaseURL())
	require.Equal(t, savedHeaderOverride, *preserved.HeaderOverride)
	require.Equal(t, "http://127.0.0.1:1", preserved.GetSetting().Proxy)

	previewConfig := dto.AdvancedCustomConfig{Routes: []dto.AdvancedCustomRoute{{
		IncomingPath: dto.AdvancedCustomModelListPath,
		UpstreamPath: "/edited/models",
		Converter:    "none",
	}}}
	configBytes, err := common.Marshal(previewConfig)
	require.NoError(t, err)
	rawConfig := string(configBytes)
	baseURL := server.URL
	explicitEmpty := ""
	req := fetchModelsRequest{
		ChannelID:      savedChannel.Id,
		BaseURL:        &baseURL,
		Type:           constant.ChannelTypeAdvancedCustom,
		Key:            "request-key-must-be-ignored",
		AdvancedCustom: &rawConfig,
		HeaderOverride: &explicitEmpty,
		Proxy:          &explicitEmpty,
	}
	cleared, err := buildAdvancedCustomModelPreviewChannel(fetchModelsRequest{
		ChannelID:      savedChannel.Id,
		BaseURL:        &explicitEmpty,
		AdvancedCustom: &rawConfig,
		HeaderOverride: &explicitEmpty,
		Proxy:          &explicitEmpty,
	})
	require.NoError(t, err)
	require.NotNil(t, cleared.BaseURL)
	require.Empty(t, *cleared.BaseURL)
	require.NotNil(t, cleared.HeaderOverride)
	require.Empty(t, *cleared.HeaderOverride)
	require.Empty(t, cleared.GetSetting().Proxy)

	body, err := common.Marshal(req)
	require.NoError(t, err)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/channel/fetch_models", bytes.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	FetchModels(ctx)

	var response struct {
		Success bool     `json:"success"`
		Message string   `json:"message"`
		Data    []string `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success, response.Message)
	require.Equal(t, []string{"edited-preview-model"}, response.Data)
	require.NotContains(t, recorder.Body.String(), "enabled-saved-key")
	require.NotContains(t, recorder.Body.String(), "request-key-must-be-ignored")

	headers := <-receivedHeaders
	require.Equal(t, "Bearer enabled-saved-key", headers.Get("Authorization"))
	require.Empty(t, headers.Get("X-Saved"))
}

func TestFailedAdvancedCustomDetectionDoesNotStageFullRemoval(t *testing.T) {
	db := setupModelListControllerTestDB(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()

	channel := newAdvancedCustomModelListChannel(server.URL, "secret-key", "/v1/models", nil)
	channel.Name = "empty discovery response"
	channel.Models = "gpt-4.1,o3"
	settings := channel.GetOtherSettings()
	settings.UpstreamModelUpdateCheckEnabled = true
	settings.UpstreamModelUpdateAutoSyncEnabled = true
	channel.SetOtherSettings(settings)
	require.NoError(t, db.Create(channel).Error)

	modelsChanged, autoAdded, err := checkAndPersistChannelUpstreamModelUpdates(channel, &settings, true, true)
	require.ErrorContains(t, err, "no valid model IDs")
	require.False(t, modelsChanged)
	require.Zero(t, autoAdded)
	require.Empty(t, settings.UpstreamModelUpdateLastDetectedModels)
	require.Empty(t, settings.UpstreamModelUpdateLastRemovedModels)

	reloaded, err := model.GetChannelById(channel.Id, true)
	require.NoError(t, err)
	persistedSettings := reloaded.GetOtherSettings()
	require.Empty(t, persistedSettings.UpstreamModelUpdateLastDetectedModels)
	require.Empty(t, persistedSettings.UpstreamModelUpdateLastRemovedModels)
	require.Equal(t, "gpt-4.1,o3", reloaded.Models)
}

func TestFetchModelsUsesSharedChannelFetchBehavior(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "first-key" {
			t.Errorf("unexpected x-api-key header: %s", r.Header.Get("x-api-key"))
		}
		if r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected Authorization header: %s", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":" claude-sonnet "},{"id":"claude-sonnet"}]}`))
	}))
	t.Cleanup(server.Close)

	body, err := common.Marshal(map[string]any{
		"base_url": server.URL,
		"type":     constant.ChannelTypeAnthropic,
		"key":      "first-key\nsecond-key",
	})
	require.NoError(t, err)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/channel/fetch_models", bytes.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")

	FetchModels(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.JSONEq(t, `{"success":true,"message":"","data":["claude-sonnet"]}`, recorder.Body.String())
}

func TestFetchNewAPIModelsUsesOpenAIContract(t *testing.T) {
	db := setupTaskPluginDiscoveryTestDB(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/v1/models", r.URL.Path)
		assert.Equal(t, "Bearer new-api-key", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, err := w.Write([]byte(`{"data":[{"id":"gpt-5"},{"id":" gpt-5-mini "}]}`))
		assert.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	baseURL := server.URL
	channel := &model.Channel{
		Type:    constant.ChannelTypeNewAPI,
		Key:     "new-api-key",
		BaseURL: &baseURL,
	}

	models, err := fetchChannelUpstreamModelIDs(channel)

	require.NoError(t, err)
	require.Equal(t, []string{"gpt-5", "gpt-5-mini"}, models)
	require.NoError(t, db.Create(channel).Error)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "id", Value: fmt.Sprint(channel.Id)}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/channel/fetch_models/"+fmt.Sprint(channel.Id), nil)
	FetchUpstreamModels(ctx)
	assert.JSONEq(t, `{"success":true,"message":"","data":["gpt-5","gpt-5-mini"]}`, recorder.Body.String())
}

func TestNormalizeModelNames(t *testing.T) {
	result := normalizeModelNames([]string{
		" gpt-4o ",
		"",
		"gpt-4o",
		"gpt-4.1",
		"   ",
	})

	require.Equal(t, []string{"gpt-4o", "gpt-4.1"}, result)
}

func TestMergeModelNames(t *testing.T) {
	result := mergeModelNames(
		[]string{"gpt-4o", "gpt-4.1"},
		[]string{"gpt-4.1", " gpt-4.1-mini ", "gpt-4o"},
	)

	require.Equal(t, []string{"gpt-4o", "gpt-4.1", "gpt-4.1-mini"}, result)
}

func TestSubtractModelNames(t *testing.T) {
	result := subtractModelNames(
		[]string{"gpt-4o", "gpt-4.1", "gpt-4.1-mini"},
		[]string{"gpt-4.1", "not-exists"},
	)

	require.Equal(t, []string{"gpt-4o", "gpt-4.1-mini"}, result)
}

func TestIntersectModelNames(t *testing.T) {
	result := intersectModelNames(
		[]string{"gpt-4o", "gpt-4.1", "gpt-4.1", "not-exists"},
		[]string{"gpt-4.1", "gpt-4o-mini", "gpt-4o"},
	)

	require.Equal(t, []string{"gpt-4o", "gpt-4.1"}, result)
}

func TestApplySelectedModelChanges(t *testing.T) {
	t.Run("add and remove together", func(t *testing.T) {
		result := applySelectedModelChanges(
			[]string{"gpt-4o", "gpt-4.1", "claude-3"},
			[]string{"gpt-4.1-mini"},
			[]string{"claude-3"},
		)

		require.Equal(t, []string{"gpt-4o", "gpt-4.1", "gpt-4.1-mini"}, result)
	})

	t.Run("add wins when conflict with remove", func(t *testing.T) {
		result := applySelectedModelChanges(
			[]string{"gpt-4o"},
			[]string{"gpt-4.1"},
			[]string{"gpt-4.1"},
		)

		require.Equal(t, []string{"gpt-4o", "gpt-4.1"}, result)
	})
}

func TestCollectPendingApplyUpstreamModelChanges(t *testing.T) {
	settings := dto.ChannelOtherSettings{
		UpstreamModelUpdateLastDetectedModels: []string{" gpt-4o ", "gpt-4o", "gpt-4.1"},
		UpstreamModelUpdateLastRemovedModels:  []string{" old-model ", "", "old-model"},
	}

	pendingAddModels, pendingRemoveModels := collectPendingApplyUpstreamModelChanges(settings)

	require.Equal(t, []string{"gpt-4o", "gpt-4.1"}, pendingAddModels)
	require.Equal(t, []string{"old-model"}, pendingRemoveModels)
}

func TestNormalizeChannelModelMapping(t *testing.T) {
	modelMapping := `{
		" alias-model ": " upstream-model ",
		"": "invalid",
		"invalid-target": ""
	}`
	channel := &model.Channel{
		ModelMapping: &modelMapping,
	}

	result := normalizeChannelModelMapping(channel)
	require.Equal(t, map[string]string{
		"alias-model": "upstream-model",
	}, result)
}

func TestCollectPendingUpstreamModelChangesFromModels_WithModelMapping(t *testing.T) {
	pendingAddModels, pendingRemoveModels := collectPendingUpstreamModelChangesFromModels(
		[]string{"alias-model", "gpt-4o", "stale-model"},
		[]string{"gpt-4o", "gpt-4.1", "mapped-target"},
		[]string{"gpt-4.1"},
		map[string]string{
			"alias-model": "mapped-target",
		},
	)

	require.Equal(t, []string{}, pendingAddModels)
	require.Equal(t, []string{"stale-model"}, pendingRemoveModels)
}

func TestCollectPendingUpstreamModelChangesFromModels_WithIgnoredRegexPatterns(t *testing.T) {
	pendingAddModels, pendingRemoveModels := collectPendingUpstreamModelChangesFromModels(
		[]string{"gpt-4o"},
		[]string{"gpt-4o", "claude-3-5-sonnet", "sora-video", "gpt-4.1"},
		[]string{"regex:^sora-.*$", "gpt-4.1"},
		nil,
	)

	require.Equal(t, []string{"claude-3-5-sonnet"}, pendingAddModels)
	require.Equal(t, []string{}, pendingRemoveModels)
}

func TestBuildUpstreamModelUpdateTaskNotificationContent_OmitOverflowDetails(t *testing.T) {
	channelSummaries := make([]upstreamModelUpdateChannelSummary, 0, 12)
	for i := range 12 {
		channelSummaries = append(channelSummaries, upstreamModelUpdateChannelSummary{
			ChannelName: "channel-" + string(rune('A'+i)),
			AddCount:    i + 1,
			RemoveCount: i,
		})
	}

	require.NoError(t, i18n.Init())
	content := buildUpstreamModelUpdateTaskNotificationContent(
		i18n.LangEn,
		24,
		12,
		56,
		21,
		9,
		[]int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12},
		channelSummaries,
		[]string{
			"gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini", "gemini-2.5-pro", "claude-3.7-sonnet",
			"qwen-max", "deepseek-r1", "llama-3.3-70b", "mistral-large", "command-r-plus", "doubao-pro-32k",
			"hunyuan-large",
		},
		[]string{
			"gpt-3.5-turbo", "claude-2.1", "gemini-1.5-pro", "mixtral-8x7b", "qwen-plus", "glm-4",
			"yi-large", "moonshot-v1", "doubao-lite",
		},
	)

	require.Contains(t, content, i18n.Translate(i18n.LangEn, i18n.MsgChannelUpstreamUpdateMoreChannels, map[string]any{"Count": 4}))
	require.Contains(t, content, i18n.Translate(i18n.LangEn, i18n.MsgChannelUpstreamUpdateMoreOmitted, map[string]any{"Count": 1}))
	require.Contains(t, content, i18n.Translate(i18n.LangEn, i18n.MsgChannelUpstreamUpdateFailedChannels, map[string]any{
		"Shown": 10,
		"Total": 12,
		"Ids":   "1, 2, 3, 4, 5, 6, 7, 8, 9, 10",
	}))
	require.Contains(t, content, i18n.Translate(i18n.LangEn, i18n.MsgChannelUpstreamUpdateMoreOmitted, map[string]any{"Count": 2}))
}

func TestShouldSendUpstreamModelUpdateNotification(t *testing.T) {
	channelUpstreamModelUpdateNotifyState.Lock()
	channelUpstreamModelUpdateNotifyState.lastNotifiedAt = 0
	channelUpstreamModelUpdateNotifyState.lastChangedChannels = 0
	channelUpstreamModelUpdateNotifyState.lastFailedChannels = 0
	channelUpstreamModelUpdateNotifyState.Unlock()

	baseTime := int64(2000000)

	require.True(t, shouldSendUpstreamModelUpdateNotification(baseTime, 6, 0))
	require.False(t, shouldSendUpstreamModelUpdateNotification(baseTime+3600, 6, 0))
	require.True(t, shouldSendUpstreamModelUpdateNotification(baseTime+3600, 7, 0))
	require.False(t, shouldSendUpstreamModelUpdateNotification(baseTime+7200, 7, 0))
	require.True(t, shouldSendUpstreamModelUpdateNotification(baseTime+8000, 0, 3))
	require.False(t, shouldSendUpstreamModelUpdateNotification(baseTime+9000, 0, 3))
	require.True(t, shouldSendUpstreamModelUpdateNotification(baseTime+10000, 0, 4))
	require.True(t, shouldSendUpstreamModelUpdateNotification(baseTime+90000, 7, 0))
	require.True(t, shouldSendUpstreamModelUpdateNotification(baseTime+90001, 0, 0))
}

func TestDetectAllChannelUpstreamModelUpdatesRejectsExistingActiveTask(t *testing.T) {
	db := setupModelListControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.SystemTask{}, &model.SystemTaskLock{}))

	existing, err := model.CreateSystemTask(model.SystemTaskTypeModelUpdate, nil, nil)
	require.NoError(t, err)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/channel/upstream-models/detect-all", nil)

	DetectAllChannelUpstreamModelUpdates(ctx)

	require.Equal(t, http.StatusConflict, recorder.Code)
	require.Contains(t, recorder.Body.String(), existing.TaskID)
	require.Contains(t, recorder.Body.String(), "A model update task is already running or queued")
}

func TestSixProviderDiscoveryUsesAuthenticatedStandardEndpointWithoutMetadata(t *testing.T) {
	for _, key := range []string{"paisio_media", "yuxibox_media", "xcmapi_media", "artbox_media", "lxmone_media", "zhangyuge_media"} {
		t.Run(key, func(t *testing.T) {
			requests := 0
			status := http.StatusOK
			body := `{"data":[{"id":"returned-only"}]}`
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				assert.Equal(t, "GET", r.Method)
				assert.Equal(t, "/v1/models", r.URL.Path)
				assert.Equal(t, "Bearer isolated-discovery", r.Header.Get("Authorization"))
				w.WriteHeader(status)
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()
			base := server.URL + "/v1/"
			channel := &model.Channel{Type: 61, Key: "isolated-discovery", BaseURL: &base, Models: "existing-kept"}
			meta := jsplugin.Meta{APIVersion: 1, Key: key, Name: "fixture", Version: "2.0.0", Author: jsplugin.AuthorMeta{Name: "test"}, Models: []string{"static-must-not-appear"}, FetchMode: "per_task"}
			ids, err := fetchTaskPluginUpstreamModels(channel, meta)
			require.NoError(t, err)
			assert.Equal(t, []string{"returned-only"}, ids)
			assert.Equal(t, "existing-kept", channel.Models)
			body = `{"data":[]}`
			ids, err = fetchTaskPluginUpstreamModels(channel, meta)
			require.NoError(t, err)
			assert.Empty(t, ids)
			assert.Equal(t, "existing-kept", channel.Models)
			status = 401
			ids, err = fetchTaskPluginUpstreamModels(channel, meta)
			require.ErrorContains(t, err, "HTTP 401")
			assert.Nil(t, ids)
			assert.NotContains(t, err.Error(), "isolated-discovery")
			assert.Equal(t, "existing-kept", channel.Models)
			assert.Equal(t, 3, requests)
		})
	}
}
