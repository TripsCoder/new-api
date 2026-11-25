package controller

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	relaychannel "github.com/QuantumNous/new-api/relay/channel"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupGenericTaskTest(t *testing.T) *model.Task {
	t.Helper()
	originalDB := model.DB
	previousRedisEnabled := common.RedisEnabled
	common.RedisEnabled = false
	// The dialect harness lets the same fixture run against MySQL and
	// PostgreSQL when TEST_TASK_DB_DIALECT selects them; SQLite stays the default.
	database, _ := openTaskDialectDatabase(t, &model.Task{}, &model.Channel{}, &model.User{})
	model.DB = database
	t.Cleanup(func() {
		model.DB = originalDB
		common.RedisEnabled = previousRedisEnabled
	})

	require.NoError(t, database.Create(&model.User{
		Id: 7, Username: "artifact-owner", Status: common.UserStatusEnabled,
		Role: common.RoleCommonUser, Group: "default",
	}).Error)
	baseURL := "https://example.com"
	require.NoError(t, database.Create(&model.Channel{
		Id: 1, Name: "artifact", Key: "key", BaseURL: &baseURL, Status: common.ChannelStatusEnabled,
	}).Error)
	task := &model.Task{
		TaskID: "task_generic", Platform: "document", UserId: 7, ChannelId: 1,
		Status: model.TaskStatusSuccess, Progress: "100%", SubmitTime: 10, FinishTime: 20,
	}
	require.NoError(t, database.Create(task).Error)
	return task
}

func allowPrivateTaskMediaTest(t *testing.T) {
	t.Helper()
	originalFetchSetting := *system_setting.GetFetchSetting()
	system_setting.GetFetchSetting().EnableSSRFProtection = true
	system_setting.GetFetchSetting().AllowPrivateIp = true
	system_setting.GetFetchSetting().AllowedPorts = []string{"1-65535"}
	t.Cleanup(func() { *system_setting.GetFetchSetting() = originalFetchSetting })
	service.InitHttpClient()
}

func TestGetTaskDoesNotProjectArtifacts(t *testing.T) {
	task := setupGenericTaskTest(t)
	task.FailReason = "https://stale-upstream.invalid/video.mp4"
	task.PrivateData = model.TaskPrivateData{
		ResultURL: "https://private-upstream.invalid/video.mp4",
		Execution: &model.TaskExecutionSnapshot{
			TaskPlugin: &model.TaskPluginSnapshot{Key: "missing-plugin", Name: "Missing"},
		},
	}
	require.NoError(t, model.DB.Save(task).Error)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("id", 7)
	c.Params = gin.Params{{Key: "key", Value: task.TaskID}}
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID, nil)

	GetTask(c)

	assert.Equal(t, http.StatusOK, recorder.Code)
	var response map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Equal(t, task.TaskID, response["task_id"])
	assert.NotContains(t, response, "artifacts")
	assert.NotContains(t, recorder.Body.String(), "upstream.invalid")
}

func TestGetTaskReturnsKuaiziWanVideoSource(t *testing.T) {
	task := setupGenericTaskTest(t)
	registry, memoryCache := jsplugin.DefaultRegistry, common.MemoryCacheEnabled
	t.Cleanup(func() { jsplugin.DefaultRegistry, common.MemoryCacheEnabled = registry, memoryCache })
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	common.MemoryCacheEnabled = false
	source, err := os.ReadFile("../plugin-sources/kuaizi-video/dist/kuaizi_video.plugin.js")
	require.NoError(t, err)
	plugin, err := jsplugin.DefaultRegistry.Register(string(source), jsplugin.Options{})
	require.NoError(t, err)
	task.Platform = constant.TaskPlatform(plugin.Meta.Key)
	task.Action = "video_generate"
	task.Properties.UpstreamModelName = "wan3.0-video"
	task.PrivateData.Execution = &model.TaskExecutionSnapshot{
		TaskPlugin: &model.TaskPluginSnapshot{Key: plugin.Meta.Key, Version: plugin.Meta.Version, SourceSHA256: plugin.SourceSHA256},
	}
	const videoURL = "https://dashscope.example/wan.mp4?signature=fixture%2Fsignature"
	task.SetData(map[string]any{"output": map[string]string{"video_url": videoURL}})
	require.NoError(t, model.DB.Save(task).Error)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("id", task.UserId)
	c.Set("token_id", 42)
	c.Params = gin.Params{{Key: "key", Value: task.TaskID}}
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID, nil)
	GetTask(c)
	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		VideoSources map[string]string `json:"video_sources"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Equal(t, map[string]string{"video": videoURL}, response.VideoSources)
}

func TestGetTaskArtifactsReturnsEmptyForLegacyTask(t *testing.T) {
	task := setupGenericTaskTest(t)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("id", task.UserId)
	c.Params = gin.Params{{Key: "key", Value: task.TaskID}}
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID+"/artifacts", nil)

	GetTaskArtifacts(c)

	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))
	var response struct {
		TaskID    string                 `json:"task_id"`
		Artifacts []taskArtifactResponse `json:"artifacts"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Equal(t, task.TaskID, response.TaskID)
	assert.Empty(t, response.Artifacts)
}

func TestTaskArtifactFetchSourceRequiresOptInAndOriginalAuthorizedToken(t *testing.T) {
	task := setupGenericTaskTest(t)
	t.Setenv("TASK_ARTIFACT_FETCH_SOURCE_TOKEN_IDS", "")
	registry, secret, publicAddress, memoryCache := jsplugin.DefaultRegistry, common.CryptoSecret, system_setting.TaskPublicAddress, common.MemoryCacheEnabled
	t.Cleanup(func() {
		jsplugin.DefaultRegistry, common.CryptoSecret, system_setting.TaskPublicAddress, common.MemoryCacheEnabled = registry, secret, publicAddress, memoryCache
	})
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	common.CryptoSecret = "artifact-fetch-source-test"
	system_setting.TaskPublicAddress = "http://new-api:3000"
	common.MemoryCacheEnabled = false
	source, err := os.ReadFile("../plugin-sources/installed/minimax-meta/plugin.js")
	require.NoError(t, err)
	plugin, err := jsplugin.DefaultRegistry.Register(string(source), jsplugin.Options{})
	require.NoError(t, err)
	task.Platform = "minimax-meta"
	task.Properties.UpstreamModelName = "MiniMax-H3"
	task.PrivateData = model.TaskPrivateData{TokenId: 31, Execution: &model.TaskExecutionSnapshot{
		TaskPlugin: &model.TaskPluginSnapshot{Key: plugin.Meta.Key, Version: plugin.Meta.Version, SourceSHA256: plugin.SourceSHA256},
	}}
	const fetchURL = "https://files.metaso.cn/video.mp4?signature=example"
	task.SetData(map[string]any{"content": map[string]string{"url": fetchURL}})
	require.NoError(t, model.DB.Save(task).Error)
	cases := []struct {
		name, tokenSetting, include string
		user, token                 int
		want                        bool
	}{
		{"opted in", "31", "fetch_source", 7, 31, true},
		{"default off", "", "fetch_source", 7, 31, false},
		{"without query", "31", "", 7, 31, false},
		{"different owner", "31", "fetch_source", 8, 31, false},
		{"different token of owner", "32", "fetch_source", 7, 32, false},
		{"token outside configured scope", "32", "fetch_source", 7, 31, false},
		{"without relay authentication", "31", "fetch_source", 7, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TASK_ARTIFACT_FETCH_SOURCE_TOKEN_ID", tc.tokenSetting)
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Params = gin.Params{{Key: "key", Value: task.TaskID}}
			c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID+"/artifacts?include="+tc.include, nil)
			c.Set("id", tc.user)
			c.Set("token_id", tc.token)
			GetTaskArtifacts(c)
			if tc.user != task.UserId {
				require.Equal(t, http.StatusNotFound, recorder.Code)
				require.NotContains(t, recorder.Body.String(), "fetch_source")
				return
			}
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			require.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))
			var response struct{ Artifacts []taskArtifactResponse }
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			require.Len(t, response.Artifacts, 1)
			require.Contains(t, response.Artifacts[0].ContentURL, "http://new-api:3000/")
			if tc.want {
				require.NotNil(t, response.Artifacts[0].FetchSource)
				require.Equal(t, fetchURL, *response.Artifacts[0].FetchSource)
				require.NotNil(t, response.Artifacts[0].UpstreamURL)
				require.Equal(t, fetchURL, *response.Artifacts[0].UpstreamURL)
			} else {
				require.NotContains(t, recorder.Body.String(), "fetch_source")
				require.NotContains(t, recorder.Body.String(), "upstream_url")
			}
		})
	}
}

func TestCredentiallessArtifactFetchSource(t *testing.T) {
	const raw = "https://files.metaso.cn/video.mp4?signature=example"
	valid := relaychannel.TaskContentRequest{URL: raw, Method: http.MethodGet, Credentialless: true}
	require.Equal(t, raw, credentiallessArtifactFetchSource(&valid))
	valid.URL = "https://supplier.example/path/cover.png?signature=example"
	require.Equal(t, valid.URL, credentiallessArtifactFetchSource(&valid))
	for _, descriptor := range []relaychannel.TaskContentRequest{
		{URL: raw, Method: http.MethodGet},
		{URL: raw, Method: http.MethodPost, Credentialless: true},
		{URL: raw, Method: http.MethodGet, Credentialless: true, Headers: map[string]string{"Authorization": "secret"}},
		{URL: raw, Method: http.MethodGet, Credentialless: true, Body: []byte("request")},
		{URL: "https://gateway.example/v1/tasks/other/artifacts/video/content?access=example", Method: http.MethodGet, Credentialless: true},
		{URL: "https://user@files.metaso.cn/video.mp4", Method: http.MethodGet, Credentialless: true},
		{URL: "http://files.metaso.cn/video.mp4", Method: http.MethodGet, Credentialless: true},
	} {
		require.Empty(t, credentiallessArtifactFetchSource(&descriptor))
	}
}

func TestTaskArtifactFetchSourceProjectsEachFileFromStoredTask(t *testing.T) {
	task := setupGenericTaskTest(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("reading stored artifact metadata contacted the supplier")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(upstream.Close)
	require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", task.ChannelId).Update("base_url", upstream.URL).Error)
	registry, secret, publicAddress, memoryCache := jsplugin.DefaultRegistry, common.CryptoSecret, system_setting.TaskPublicAddress, common.MemoryCacheEnabled
	t.Cleanup(func() {
		jsplugin.DefaultRegistry, common.CryptoSecret, system_setting.TaskPublicAddress, common.MemoryCacheEnabled = registry, secret, publicAddress, memoryCache
	})
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	common.CryptoSecret = "artifact-source-test"
	system_setting.TaskPublicAddress = "http://new-api:3000"
	common.MemoryCacheEnabled = false
	t.Setenv("TASK_ARTIFACT_FETCH_SOURCE_TOKEN_ID", "")
	t.Setenv("TASK_ARTIFACT_FETCH_SOURCE_TOKEN_IDS", "30, 31")
	const pluginSource = `
export const meta = {key: "source-fixture", name: "Source fixture", version: "1.0.0", apiVersion: 1, author: {name: "Test"}, models: ["fixture"], fetchMode: "per_task", allowedHosts: ["files.supplier.example"]};
export function buildSubmitRequest(ctx) { return {url: ctx.baseUrl + "/submit"}; }
export function parseSubmitResponse() { return {taskId: "fixture"}; }
export function buildQueryRequest(ctx) { return {url: ctx.baseUrl + "/query"}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
export function listArtifacts(task) {
  return ["image", "video", "audio", "file", "other"].map(key => ({ key, type: key === "other" ? "file" : key }));
}
export function buildContentRequest(ctx) {
  if (ctx.apiKey || ctx.authHeader) throw new Error("unexpected credentials");
  if (ctx.artifactKey === "other") utils.fetch({url: ctx.baseUrl + "/never", method: "GET"});
  if (ctx.artifactKey === "file") return {url: ctx.data.file, method: "GET", headers: {"x-vendor-auth": "required"}};
  return {url: ctx.data[ctx.artifactKey], method: "GET", credentialless: true};
}`
	plugin, err := jsplugin.DefaultRegistry.Register(pluginSource, jsplugin.Options{})
	require.NoError(t, err)
	task.Platform = "source-fixture"
	task.PrivateData = model.TaskPrivateData{TokenId: 31, Execution: &model.TaskExecutionSnapshot{
		TaskPlugin: &model.TaskPluginSnapshot{Key: plugin.Meta.Key, Version: plugin.Meta.Version, SourceSHA256: plugin.SourceSHA256},
	}}
	sources := map[string]string{
		"image": "https://images.supplier.example/photo.png",
		"video": "https://video.supplier.example/video.mp4?signature=a%2Fb",
		"audio": "https://audio.supplier.example/track.mp3",
		"file":  "https://files.supplier.example/captions.vtt",
	}
	task.SetData(sources)
	require.NoError(t, model.DB.Save(task).Error)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Params = gin.Params{{Key: "key", Value: task.TaskID}}
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID+"/artifacts?include=fetch_source", nil)
	c.Set("id", task.UserId)
	c.Set("token_id", 31)
	GetTaskArtifacts(c)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var response struct{ Artifacts []taskArtifactResponse }
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.Len(t, response.Artifacts, 5)
	for _, item := range response.Artifacts {
		require.Contains(t, item.ContentURL, "/artifacts/"+item.Key+"/content?")
		require.NotNil(t, item.UpstreamURL)
		require.Equal(t, sources[item.Key], *item.UpstreamURL)
		require.NotNil(t, item.FetchSource)
		if item.Key == "file" {
			require.Empty(t, *item.FetchSource)
		} else {
			require.Equal(t, sources[item.Key], *item.FetchSource)
		}
	}

	// The same stored result now supplies the video URL from the normal status
	// query using the existing task-owner check, independent of artifact options.
	t.Setenv("TASK_ARTIFACT_FETCH_SOURCE_TOKEN_IDS", "")
	for _, tc := range []struct {
		name      string
		user      int
		status    model.TaskStatus
		discarded bool
		code      int
	}{
		{"owner", task.UserId, model.TaskStatusSuccess, false, http.StatusOK},
		{"foreign user", task.UserId + 1, model.TaskStatusSuccess, false, http.StatusNotFound},
		{"unfinished", task.UserId, model.TaskStatusInProgress, false, http.StatusOK},
		{"discarded", task.UserId, model.TaskStatusSuccess, true, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task.Status = tc.status
			task.PrivateData.ResultDiscarded = tc.discarded
			require.NoError(t, model.DB.Save(task).Error)
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Params = gin.Params{{Key: "key", Value: task.TaskID}}
			c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID, nil)
			c.Set("id", tc.user)
			c.Set("token_id", 42) // An authenticated token of the same account also uses ordinary status permissions.
			GetTask(c)
			require.Equal(t, tc.code, recorder.Code, recorder.Body.String())
			if tc.name == "owner" {
				var status struct {
					VideoSources map[string]string `json:"video_sources"`
				}
				require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &status))
				assert.Equal(t, map[string]string{"video": sources["video"]}, status.VideoSources)
				assert.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))
				assert.NotContains(t, recorder.Body.String(), sources["image"])
				assert.NotContains(t, recorder.Body.String(), sources["file"])
			} else {
				assert.NotContains(t, recorder.Body.String(), "video_sources")
				assert.NotContains(t, recorder.Body.String(), sources["video"])
			}
		})
	}
}

func TestTaskArtifactAuthorizationKeepsForeignTasksHidden(t *testing.T) {
	task := setupGenericTaskTest(t)

	commonUser, _ := gin.CreateTestContext(httptest.NewRecorder())
	commonUser.Set("id", 8)
	commonUser.Set("role", common.RoleCommonUser)
	_, exists, err := getTaskForArtifactRequest(commonUser, task.TaskID)
	require.NoError(t, err)
	assert.False(t, exists)

	admin, _ := gin.CreateTestContext(httptest.NewRecorder())
	admin.Set("id", 8)
	admin.Set("role", common.RoleAdminUser)
	found, exists, err := getTaskForArtifactRequest(admin, task.TaskID)
	require.NoError(t, err)
	require.True(t, exists)
	assert.Equal(t, task.TaskID, found.TaskID)

	apiToken, _ := gin.CreateTestContext(httptest.NewRecorder())
	apiToken.Set("id", 8)
	apiToken.Set("role", common.RoleRootUser)
	apiToken.Set("token_id", 99)
	_, exists, err = getTaskForArtifactRequest(apiToken, task.TaskID)
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestDashboardTaskArtifactsReturnsLegacyCapabilityWithoutUpstreamURL(t *testing.T) {
	task := setupGenericTaskTest(t)
	previousSecret := common.CryptoSecret
	previousPublicAddress := system_setting.TaskPublicAddress
	common.CryptoSecret = "controller-task-artifact-access-secret"
	system_setting.TaskPublicAddress = "https://gateway.example/prefix"
	t.Cleanup(func() {
		common.CryptoSecret = previousSecret
		system_setting.TaskPublicAddress = previousPublicAddress
	})
	task.Action = constant.TaskActionTextToVideo
	task.FailReason = "https://upstream.invalid/private-video.mp4?signature=secret"
	require.NoError(t, model.DB.Save(task).Error)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("id", task.UserId)
	c.Set("role", common.RoleCommonUser)
	c.Params = gin.Params{{Key: "task_id", Value: task.TaskID}}
	c.Request = httptest.NewRequest(http.MethodGet, "/api/task/"+task.TaskID+"/artifacts", nil)

	GetDashboardTaskArtifacts(c)

	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			Artifacts        []taskArtifactResponse `json:"artifacts"`
			LegacyContentURL string                 `json:"legacy_content_url"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.True(t, response.Success)
	assert.Empty(t, response.Data.Artifacts)
	contentURL, err := url.Parse(response.Data.LegacyContentURL)
	require.NoError(t, err)
	assert.Equal(t, "/prefix/v1/tasks/"+task.TaskID+"/artifacts/video/content", contentURL.Path)
	assert.True(t, service.VerifyTaskArtifactAccess(
		contentURL.Query().Get(service.TaskArtifactAccessQueryParameter),
		task.TaskID,
		"video",
	))
	assert.NotContains(t, recorder.Body.String(), "upstream.invalid")
	assert.NotContains(t, recorder.Body.String(), "signature=secret")
}

// Task lists no longer carry the persisted snapshot, so the dashboard reads a
// legacy Suno task's playable clips from the artifacts endpoint instead.
func TestDashboardTaskArtifactsProjectsLegacySunoAudioClips(t *testing.T) {
	task := setupGenericTaskTest(t)
	task.Platform = constant.TaskPlatformSuno
	task.Action = "MUSIC"
	task.Data = []byte(`[{"id":"clip-1","title":"Song","audio_url":"https://cdn.example/a.mp3","metadata":{"tags":"pop","duration":30},"lyric":"private"},{"id":"clip-2","title":"No audio"}]`)
	require.NoError(t, model.DB.Save(task).Error)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("id", task.UserId)
	c.Set("role", common.RoleCommonUser)
	c.Params = gin.Params{{Key: "task_id", Value: task.TaskID}}
	c.Request = httptest.NewRequest(http.MethodGet, "/api/task/"+task.TaskID+"/artifacts", nil)

	GetDashboardTaskArtifacts(c)

	assert.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			Artifacts        []taskArtifactResponse `json:"artifacts"`
			LegacyAudioClips []map[string]any       `json:"legacy_audio_clips"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.True(t, response.Success)
	assert.Empty(t, response.Data.Artifacts)
	require.Len(t, response.Data.LegacyAudioClips, 1)
	assert.Equal(t, "https://cdn.example/a.mp3", response.Data.LegacyAudioClips[0]["audio_url"])
	assert.Equal(t, "Song", response.Data.LegacyAudioClips[0]["title"])
	assert.NotContains(t, recorder.Body.String(), "private")
}

// Task lists omit the data column; the API DTO keeps the key as null so shape
// checks survive while the payload no longer travels with every row.
func TestTaskListsOmitPersistedSnapshot(t *testing.T) {
	task := setupGenericTaskTest(t)
	task.Data = []byte(`{"data":[{"url":"https://cdn.example/a.png"}]}`)
	require.NoError(t, model.DB.Save(task).Error)

	userTasks := model.TaskGetAllUserTask(task.UserId, 0, 10, model.SyncTaskQueryParams{})
	require.Len(t, userTasks, 1)
	assert.Empty(t, userTasks[0].Data)
	adminTasks := model.TaskGetAllTasks(0, 10, model.SyncTaskQueryParams{})
	require.Len(t, adminTasks, 1)
	assert.Empty(t, adminTasks[0].Data)
	assert.Equal(t, task.TaskID, adminTasks[0].TaskID)

	encoded, err := common.Marshal(tasksToDto(adminTasks, false, common.RoleAdminUser)[0])
	require.NoError(t, err)
	assert.Contains(t, string(encoded), `"data":null`)
	assert.NotContains(t, string(encoded), `"result_discarded"`)

	adminTasks[0].PrivateData.ResultDiscarded = true
	encoded, err = common.Marshal(tasksToDto(adminTasks, false, common.RoleAdminUser)[0])
	require.NoError(t, err)
	assert.Contains(t, string(encoded), `"result_discarded":true`, "task lists tell the UI that an inline result was not retained")

	stored, exists, err := model.GetByTaskId(task.UserId, task.TaskID)
	require.NoError(t, err)
	require.True(t, exists)
	assert.JSONEq(t, string(task.Data), string(stored.Data), "single-task lookups keep the snapshot")
}

func TestTaskArtifactAccessRequiresActiveOwner(t *testing.T) {
	task := setupGenericTaskTest(t)
	task.Action = constant.TaskActionTextToVideo
	task.FailReason = "https://upstream.invalid/private-video.mp4"
	require.NoError(t, model.DB.Save(task).Error)
	require.NoError(t, model.DB.Model(&model.User{}).
		Where("id = ?", task.UserId).
		Update("status", common.UserStatusDisabled).Error)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set(middleware.TaskArtifactAccessContextKey, true)
	c.Params = gin.Params{
		{Key: "key", Value: task.TaskID},
		{Key: "artifact_key", Value: "video"},
	}
	c.Request = httptest.NewRequest(
		http.MethodGet,
		"/v1/tasks/"+task.TaskID+"/artifacts/video/content",
		nil,
	)

	TaskArtifactContent(c)

	assert.Equal(t, http.StatusNotFound, recorder.Code)
	assert.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))
}

func TestTaskArtifactAccessRejectsAmbiguousHistoricalTaskID(t *testing.T) {
	task := setupGenericTaskTest(t)
	task.Action = constant.TaskActionTextToVideo
	task.FailReason = "https://first-upstream.invalid/video.mp4"
	require.NoError(t, model.DB.Save(task).Error)
	require.NoError(t, model.DB.Create(&model.User{
		Id: 8, Username: "other-artifact-owner", Status: common.UserStatusEnabled,
		Role: common.RoleCommonUser, Group: "default", AffCode: "artifact-owner-8",
	}).Error)
	require.NoError(t, model.DB.Create(&model.Task{
		TaskID: task.TaskID, Platform: task.Platform, UserId: 8, ChannelId: task.ChannelId,
		Action: constant.TaskActionTextToVideo, Status: model.TaskStatusSuccess,
		FailReason: "https://second-upstream.invalid/video.mp4",
	}).Error)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set(middleware.TaskArtifactAccessContextKey, true)
	c.Params = gin.Params{
		{Key: "key", Value: task.TaskID},
		{Key: "artifact_key", Value: "video"},
	}
	c.Request = httptest.NewRequest(
		http.MethodGet,
		"/v1/tasks/"+task.TaskID+"/artifacts/video/content",
		nil,
	)

	TaskArtifactContent(c)

	assert.Equal(t, http.StatusNotFound, recorder.Code)
	assert.NotContains(t, recorder.Body.String(), "upstream.invalid")
}

func TestLegacyVideoArtifactContentUsesGetResultURL(t *testing.T) {
	task := setupGenericTaskTest(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "bytes=0-3", r.Header.Get("Range"))
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 0-3/4")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("data"))
	}))
	defer upstream.Close()
	allowPrivateTaskMediaTest(t)

	task.Action = constant.TaskActionTextToVideo
	task.PrivateData.ResultURL = upstream.URL
	task.FailReason = "https://stale.invalid/legacy-fallback.mp4"
	require.NoError(t, model.DB.Save(task).Error)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set(middleware.TaskArtifactAccessContextKey, true)
	c.Params = gin.Params{
		{Key: "key", Value: task.TaskID},
		{Key: "artifact_key", Value: "video"},
	}
	c.Request = httptest.NewRequest(
		http.MethodGet,
		"/v1/tasks/"+task.TaskID+"/artifacts/video/content",
		nil,
	)
	c.Request.Header.Set("Range", "bytes=0-3")

	TaskArtifactContent(c)

	assert.Equal(t, http.StatusPartialContent, recorder.Code)
	assert.Equal(t, "data", recorder.Body.String())
	assert.Equal(t, "bytes 0-3/4", recorder.Header().Get("Content-Range"))
}

func TestDisabledArtifactStorePreservesPluginUpstreamContent(t *testing.T) {
	task := setupGenericTaskTest(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "provider-key", r.Header.Get("x-goog-api-key"))
		assert.Equal(t, "bytes=0-13", r.Header.Get("Range"))
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 0-13/14")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("artifact-bytes"))
	}))
	defer upstream.Close()
	allowPrivateTaskMediaTest(t)
	previousMemoryCache := common.MemoryCacheEnabled
	common.MemoryCacheEnabled = false
	t.Cleanup(func() { common.MemoryCacheEnabled = previousMemoryCache })

	require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", task.ChannelId).Updates(map[string]any{
		"type":     constant.ChannelTypeGemini,
		"key":      "provider-key",
		"base_url": upstream.URL,
	}).Error)
	task.Platform = constant.TaskPlatform("google")
	task.PrivateData.Execution = &model.TaskExecutionSnapshot{TaskPlugin: &model.TaskPluginSnapshot{
		Key: "google", Name: "Google Veo (Gemini API)", Version: "1.0.0", APIVersion: 1,
	}}
	task.SetData(map[string]any{"response": map[string]any{
		"generateVideoResponse": map[string]any{
			"generatedVideos": []any{map[string]any{"video": map[string]any{"uri": upstream.URL}}},
		},
	}})
	require.NoError(t, model.DB.Save(task).Error)
	require.False(t, service.GetTaskArtifactStore().Enabled())

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set(middleware.TaskArtifactAccessContextKey, true)
	c.Params = gin.Params{
		{Key: "key", Value: task.TaskID},
		{Key: "artifact_key", Value: "video"},
	}
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID+"/artifacts/video/content", nil)
	c.Request.Header.Set("Range", "bytes=0-13")

	TaskArtifactContent(c)

	assert.Equal(t, http.StatusPartialContent, recorder.Code)
	assert.Equal(t, "artifact-bytes", recorder.Body.String())
	assert.Equal(t, "video/mp4", recorder.Header().Get("Content-Type"))
	assert.Equal(t, "bytes 0-13/14", recorder.Header().Get("Content-Range"))
}

// hailuo looks the MiniMax download link up with utils.fetch; the signed OSS
// link then gets a plain GET without the channel key, even for HEAD clients.
func TestTaskArtifactContentFollowsHailuoRetrieveLink(t *testing.T) {
	task := setupGenericTaskTest(t)
	var mu sync.Mutex
	var ossRequests []string
	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/files/retrieve":
			assert.Equal(t, "Bearer provider-key", r.Header.Get("Authorization"))
			if r.URL.Query().Get("file_id") == "login-fail" {
				_, _ = w.Write([]byte(`{"base_resp":{"status_code":1004,"status_msg":"login fail"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"file":{"download_url":"` + upstream.URL + `/oss/video.mp4?Expires=1&Signature=sig"},"base_resp":{"status_code":0}}`))
		case "/oss/video.mp4":
			mu.Lock()
			ossRequests = append(ossRequests, r.Method+" range="+r.Header.Get("Range")+" authorization="+r.Header.Get("Authorization"))
			mu.Unlock()
			w.Header().Set("Content-Type", "video/mp4")
			if r.Header.Get("Range") != "" {
				w.Header().Set("Content-Range", "bytes 0-3/10")
				w.WriteHeader(http.StatusPartialContent)
				_, _ = w.Write([]byte("mp4!"))
				return
			}
			_, _ = w.Write([]byte("mp4!video!"))
		default:
			t.Errorf("unexpected upstream request %s", r.URL.Path)
		}
	}))
	defer upstream.Close()
	allowPrivateTaskMediaTest(t)
	previousMemoryCache := common.MemoryCacheEnabled
	common.MemoryCacheEnabled = false
	t.Cleanup(func() { common.MemoryCacheEnabled = previousMemoryCache })

	require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", task.ChannelId).Updates(map[string]any{
		"type":     constant.ChannelTypeMiniMax,
		"key":      "provider-key",
		"base_url": upstream.URL,
	}).Error)
	task.Platform = constant.TaskPlatform("hailuo")
	task.PrivateData.Execution = &model.TaskExecutionSnapshot{TaskPlugin: &model.TaskPluginSnapshot{
		Key: "hailuo", Name: "Hailuo", Version: "1.2.0", APIVersion: 1,
	}}
	request := func(method, fileID string) *httptest.ResponseRecorder {
		task.SetData(map[string]any{"file_id": fileID})
		require.NoError(t, model.DB.Save(task).Error)
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Set("id", 7)
		c.Params = gin.Params{{Key: "key", Value: task.TaskID}, {Key: "artifact_key", Value: "video"}}
		c.Request = httptest.NewRequest(method, "/v1/tasks/"+task.TaskID+"/artifacts/video/content", nil)
		if method == http.MethodGet {
			c.Request.Header.Set("Range", "bytes=0-3")
		}
		TaskArtifactContent(c)
		return recorder
	}

	ranged := request(http.MethodGet, "file-1")
	assert.Equal(t, http.StatusPartialContent, ranged.Code)
	assert.Equal(t, "mp4!", ranged.Body.String())
	assert.Equal(t, "bytes 0-3/10", ranged.Header().Get("Content-Range"))

	head := request(http.MethodHead, "file-1")
	assert.Equal(t, http.StatusOK, head.Code)
	assert.Empty(t, head.Body.String())
	assert.Equal(t, "video/mp4", head.Header().Get("Content-Type"))

	failed := request(http.MethodGet, "login-fail")
	assert.Equal(t, http.StatusInternalServerError, failed.Code)
	assert.Contains(t, failed.Body.String(), "artifact_plugin_error")

	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []string{"GET range=bytes=0-3 authorization=", "GET range= authorization="}, ossRequests)
}

func TestProjectedTaskArtifactValidationRejectsAmbiguousIdentity(t *testing.T) {
	validated, err := validateProjectedTaskArtifacts([]relaychannel.TaskArtifact{
		{Key: "video-main", Type: "video", MimeType: "video/mp4"},
		{Key: "cover.main", Type: "image", MimeType: "image/png"},
	})
	require.NoError(t, err)
	require.Len(t, validated, 2)
	assert.Equal(t, "video-main", validated[0].Key)

	for _, artifacts := range [][]relaychannel.TaskArtifact{
		{{Key: "../video", Type: "video"}},
		{{Key: "video/0", Type: "video"}},
		{{Key: "video-main", Type: "video"}, {Key: "video-main", Type: "image"}},
		{{Key: "video-main", Type: "unknown"}},
		{{Key: "video-main", Type: "video", MimeType: "video/mp4\r\nX-Test: injected"}},
	} {
		_, err := validateProjectedTaskArtifacts(artifacts)
		assert.ErrorIs(t, err, errTaskArtifactPlugin)
	}
}

func TestProxyTaskMediaForwardsRangeAndFiltersResponseHeaders(t *testing.T) {
	task := setupGenericTaskTest(t)
	var receivedRange, receivedAuthorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedRange = r.Header.Get("Range")
		receivedAuthorization = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 0-3/10")
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Set-Cookie", "provider=secret")
		w.Header().Set("WWW-Authenticate", "Bearer provider")
		w.Header().Set("X-Provider-Secret", "hidden")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("data"))
	}))
	defer upstream.Close()

	allowPrivateTaskMediaTest(t)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/task_generic/artifacts/video-main/content", nil)
	c.Request.Header.Set("Range", "bytes=0-3")

	err := proxyTaskMedia(c, task, &relaychannel.TaskContentRequest{
		URL:     upstream.URL,
		Method:  http.MethodGet,
		Headers: map[string]string{"Authorization": "Bearer provider-secret"},
	})

	require.NoError(t, err)
	assert.Equal(t, http.StatusPartialContent, recorder.Code)
	assert.Equal(t, "data", recorder.Body.String())
	assert.Equal(t, "bytes=0-3", receivedRange)
	assert.Equal(t, "Bearer provider-secret", receivedAuthorization)
	assert.Equal(t, "bytes 0-3/10", recorder.Header().Get("Content-Range"))
	assert.Equal(t, "bytes", recorder.Header().Get("Accept-Ranges"))
	assert.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))
	assert.Equal(t, "sandbox; default-src 'none'", recorder.Header().Get("Content-Security-Policy"))
	assert.Equal(t, "no-referrer", recorder.Header().Get("Referrer-Policy"))
	assert.Equal(t, "nosniff", recorder.Header().Get("X-Content-Type-Options"))
	assert.Empty(t, recorder.Header().Get("Set-Cookie"))
	assert.Empty(t, recorder.Header().Get("WWW-Authenticate"))
	assert.Empty(t, recorder.Header().Get("X-Provider-Secret"))
}

func TestProxyTaskMediaPassesThroughUnsatisfiedRange(t *testing.T) {
	task := setupGenericTaskTest(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Range", "bytes */10")
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
	}))
	defer upstream.Close()

	allowPrivateTaskMediaTest(t)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/content", nil)

	require.NoError(t, proxyTaskMedia(c, task, &relaychannel.TaskContentRequest{
		URL: upstream.URL, Method: http.MethodGet,
	}))
	assert.Equal(t, http.StatusRequestedRangeNotSatisfiable, recorder.Code)
	assert.Equal(t, "bytes */10", recorder.Header().Get("Content-Range"))
	assert.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))
}

func TestTaskMediaResponseHeaderTimeoutDoesNotTruncateBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		time.Sleep(75 * time.Millisecond)
		_, _ = w.Write([]byte("complete-body"))
	}))
	defer upstream.Close()

	request, err := http.NewRequest(http.MethodGet, upstream.URL, nil)
	require.NoError(t, err)
	response, err := doTaskMediaRequest(upstream.Client(), request, 20*time.Millisecond)
	require.NoError(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	assert.Equal(t, "complete-body", string(body))
}

func TestTaskMediaResponseHeaderTimeoutCancelsBeforeHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(75 * time.Millisecond)
		_, _ = w.Write([]byte("late"))
	}))
	defer upstream.Close()

	request, err := http.NewRequest(http.MethodGet, upstream.URL, nil)
	require.NoError(t, err)
	_, err = doTaskMediaRequest(upstream.Client(), request, 10*time.Millisecond)
	assert.ErrorIs(t, err, context.DeadlineExceeded)
}

func TestWriteVideoDataURLStreamsAndSupportsHead(t *testing.T) {
	const dataURL = "data:video/mp4;base64,Y29tcGxldGUtYm9keQ=="

	getRecorder := httptest.NewRecorder()
	getContext, _ := gin.CreateTestContext(getRecorder)
	getContext.Request = httptest.NewRequest(http.MethodGet, "/content", nil)
	require.NoError(t, writeVideoDataURL(getContext, dataURL))
	assert.Equal(t, http.StatusOK, getRecorder.Code)
	assert.Equal(t, "complete-body", getRecorder.Body.String())
	assert.Equal(t, "13", getRecorder.Header().Get("Content-Length"))

	headRecorder := httptest.NewRecorder()
	headContext, _ := gin.CreateTestContext(headRecorder)
	headContext.Request = httptest.NewRequest(http.MethodHead, "/content", nil)
	require.NoError(t, writeVideoDataURL(headContext, dataURL))
	assert.Equal(t, http.StatusOK, headRecorder.Code)
	assert.Empty(t, headRecorder.Body.String())
	assert.Equal(t, "13", headRecorder.Header().Get("Content-Length"))
}

func TestWriteVideoDataURLRejectsOversizedPayloadBeforeDecode(t *testing.T) {
	previousLimit := taskMediaDataURLMaxEncodedBytes
	taskMediaDataURLMaxEncodedBytes = 32
	t.Cleanup(func() { taskMediaDataURLMaxEncodedBytes = previousLimit })

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/content", nil)

	err := writeVideoDataURL(c, "data:video/mp4;base64,"+strings.Repeat("A", 64))

	assert.ErrorIs(t, err, errTaskMediaRequestRejected)
	assert.Empty(t, recorder.Header().Get("Content-Type"))
}

func TestProxyTaskMediaStripsCredentialsOnCrossOriginDownloadRedirect(t *testing.T) {
	task := setupGenericTaskTest(t)
	var destinationAuthorization, destinationRange string
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destinationAuthorization = r.Header.Get("Authorization")
		destinationRange = r.Header.Get("Range")
		_, _ = w.Write([]byte("redirected"))
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusFound)
	}))
	defer source.Close()
	allowPrivateTaskMediaTest(t)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/content", nil)
	c.Request.Header.Set("Range", "bytes=0-3")

	err := proxyTaskMedia(c, task, &relaychannel.TaskContentRequest{
		URL: source.URL, Method: http.MethodGet, Credentialless: true,
	})
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "redirected", recorder.Body.String())
	assert.Empty(t, destinationAuthorization)
	assert.Equal(t, "bytes=0-3", destinationRange)

	destinationRange = ""
	credentialedRecorder := httptest.NewRecorder()
	credentialedContext, _ := gin.CreateTestContext(credentialedRecorder)
	credentialedContext.Request = httptest.NewRequest(http.MethodGet, "/content", nil)
	credentialedContext.Request.Header.Set("Range", "bytes=0-3")
	err = proxyTaskMedia(credentialedContext, task, &relaychannel.TaskContentRequest{
		URL: source.URL, Method: http.MethodGet,
		Headers: map[string]string{"Authorization": "Bearer provider-secret"},
	})
	require.NoError(t, err)
	assert.Equal(t, "redirected", credentialedRecorder.Body.String())
	assert.Empty(t, destinationAuthorization)
	assert.Equal(t, "bytes=0-3", destinationRange)
}

func TestTaskMediaRequestHeaderPolicy(t *testing.T) {
	header := http.Header{}
	require.NoError(t, applyTaskMediaRequestHeaders(header, map[string]string{
		"Authorization": "Bearer provider-secret",
		"X-Signature":   "signed",
	}))
	assert.Equal(t, "Bearer provider-secret", header.Get("Authorization"))
	assert.Equal(t, "signed", header.Get("X-Signature"))

	for _, name := range []string{"Host", "Content-Length", "Accept-Encoding", "Connection", "Proxy-Authorization", "Transfer-Encoding"} {
		t.Run(name, func(t *testing.T) {
			assert.ErrorIs(t, applyTaskMediaRequestHeaders(http.Header{}, map[string]string{name: "bad"}), errTaskMediaRequestRejected)
		})
	}
	assert.ErrorIs(t, applyTaskMediaRequestHeaders(http.Header{}, map[string]string{"X-Test": "bad\r\ninjected"}), errTaskMediaRequestRejected)
}

func TestCredentiallessTaskMediaDescriptorRejectsCredentialsAndBody(t *testing.T) {
	task := setupGenericTaskTest(t)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/content", nil)

	for _, descriptor := range []*relaychannel.TaskContentRequest{
		{URL: "https://example.com/video", Method: http.MethodPost, Credentialless: true},
		{URL: "https://example.com/video", Method: http.MethodGet, Body: []byte("secret"), Credentialless: true},
		{URL: "https://example.com/video", Method: http.MethodGet, Headers: map[string]string{"X-Key": "secret"}, Credentialless: true},
	} {
		err := proxyTaskMedia(c, task, descriptor)
		var proxyErr *taskMediaProxyError
		require.ErrorAs(t, err, &proxyErr)
		assert.Equal(t, "artifact_request_rejected", proxyErr.code)
	}
}

func TestSelfTaskMediaURLGuard(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "https://gateway.example/v1/videos/task-1/content", nil)
	c.Request.Host = "gateway.example"

	selfURL, err := url.Parse("https://gateway.example/v1/videos/task-1/content")
	require.NoError(t, err)
	assert.True(t, isSelfTaskMediaURL(c, selfURL))

	remoteURL, err := url.Parse("https://cdn.example/v1/videos/task-1/content")
	require.NoError(t, err)
	assert.False(t, isSelfTaskMediaURL(c, remoteURL))
	assert.True(t, isTaskMediaFallbackLoop(remoteURL.String(), "task-1"))
	assert.False(t, isTaskMediaFallbackLoop(remoteURL.String(), "task-2"))
}

func TestRequestedTaskReadRejectsMismatchedChannelAfterOwnership(t *testing.T) {
	require.NoError(t, i18n.Init())
	task := setupGenericTaskTest(t)
	for _, handler := range []struct {
		name string
		run  gin.HandlerFunc
	}{
		{name: "task", run: GetTask},
		{name: "artifacts", run: GetTaskArtifacts},
		{name: "dashboard artifacts", run: GetDashboardTaskArtifacts},
		{name: "artifact content", run: TaskArtifactContent},
		{name: "video content", run: VideoProxy},
	} {
		for _, owner := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/owner=%t", handler.name, owner), func(t *testing.T) {
				recorder := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(recorder)
				c.Set("id", task.UserId)
				if !owner {
					c.Set("id", task.UserId+1)
				}
				c.Params = gin.Params{{Key: "key", Value: task.TaskID}, {Key: "task_id", Value: task.TaskID}, {Key: "artifact_key", Value: "video"}}
				c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID, nil)
				c.Request.Header.Set(constant.ChannelSelectionHeader, "2")
				handler.run(c)
				if owner {
					assert.Equal(t, http.StatusBadRequest, recorder.Code)
					assert.Contains(t, recorder.Body.String(), "requested channel does not match task")
				} else {
					assert.Equal(t, http.StatusNotFound, recorder.Code, "channel header cannot grant access to another owner's task")
					assert.NotContains(t, recorder.Body.String(), "requested channel")
				}
			})
		}
	}
}

func TestRequestedTaskReadPreservesHistoricalAccess(t *testing.T) {
	task := setupGenericTaskTest(t)
	require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", task.ChannelId).Update("status", common.ChannelStatusManuallyDisabled).Error)
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Set("id", task.UserId)
	c.Params = gin.Params{{Key: "key", Value: task.TaskID}}
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID, nil)
	c.Request.Header.Set(constant.ChannelSelectionHeader, "1")
	common.SetContextKey(c, constant.ContextKeyTokenModelLimitEnabled, true)
	common.SetContextKey(c, constant.ContextKeyTokenModelLimit, map[string]bool{})
	common.SetContextKey(c, constant.ContextKeyUsingGroup, "retired-group")
	GetTask(c)
	assert.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Body.String(), task.TaskID)
}

func TestRequestedTaskSignedArtifactStrictHeaderWithoutNewAuthorization(t *testing.T) {
	task := setupGenericTaskTest(t)
	task.Action = constant.TaskActionTextToVideo
	task.PrivateData.ResultURL = "data:video/mp4;base64,ZGF0YQ=="
	require.NoError(t, model.DB.Save(task).Error)
	for _, tc := range []struct {
		name       string
		values     []string
		wantStatus int
	}{
		{name: "matching", values: []string{"1"}, wantStatus: http.StatusOK},
		{name: "mismatched", values: []string{"2"}, wantStatus: http.StatusNotFound},
		{name: "duplicate", values: []string{"1", "1"}, wantStatus: http.StatusNotFound},
		{name: "noncanonical", values: []string{"01"}, wantStatus: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			// Existing middleware established the signed task/artifact grant;
			// no native token or user ID is added by channel selection.
			c.Set(middleware.TaskArtifactAccessContextKey, true)
			c.Params = gin.Params{{Key: "key", Value: task.TaskID}, {Key: "artifact_key", Value: "video"}}
			c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/"+task.TaskID+"/artifacts/video/content", nil)
			c.Request.Header[constant.ChannelSelectionHeader] = tc.values
			TaskArtifactContent(c)
			assert.Equal(t, tc.wantStatus, recorder.Code)
			assert.Empty(t, c.Request.Header.Get(constant.ChannelSelectionHeader))
			assert.Zero(t, c.GetInt("id"))
			assert.Zero(t, c.GetInt("token_id"))
			if tc.wantStatus == http.StatusOK {
				assert.Equal(t, "data", recorder.Body.String())
			} else {
				assert.NotContains(t, recorder.Body.String(), "requested channel", "signed artifact errors retain the existing non-enumerating response")
			}
		})
	}
}

func TestRequestedTaskResponseRetrieveRejectsMismatchBeforeProjection(t *testing.T) {
	require.NoError(t, i18n.Init())
	task := &model.Task{TaskID: "task_requested", UserId: 71, ChannelId: 1, Status: model.TaskStatusSuccess}
	for _, owner := range []bool{true, false} {
		t.Run(fmt.Sprintf("owner=%t", owner), func(t *testing.T) {
			c, recorder := newPluginProtocolRetrieveContext("resp_requested")
			if !owner {
				common.SetContextKey(c, constant.ContextKeyUserId, 72)
			}
			c.Request.Header.Set(constant.ChannelSelectionHeader, "2")
			deps := pluginProtocolTestDeps()
			deps.getByTaskId = func(userID int, taskID string) (*model.Task, bool, error) {
				if userID != task.UserId || taskID != task.TaskID {
					return nil, false, nil
				}
				return task, true, nil
			}
			retrieveTaskPluginResponse(c, deps)
			if owner {
				assert.Equal(t, http.StatusBadRequest, recorder.Code)
				assert.Contains(t, recorder.Body.String(), "requested channel does not match task")
			} else {
				assert.Equal(t, http.StatusNotFound, recorder.Code)
			}
		})
	}
}
