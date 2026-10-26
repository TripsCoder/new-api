package controller

import (
	"bytes"
	"context"
	"fmt"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReviewedVideoUIModelConfigurationSave(t *testing.T) {
	previousDB, previousRegistry, previousCache := model.DB, jsplugin.DefaultRegistry, common.MemoryCacheEnabled
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	model.DB, jsplugin.DefaultRegistry, common.MemoryCacheEnabled = db, jsplugin.NewRegistry(), false
	t.Cleanup(func() {
		model.DB, jsplugin.DefaultRegistry, common.MemoryCacheEnabled = previousDB, previousRegistry, previousCache
	})
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.ChannelModelConfiguration{}, &model.TaskPlugin{}, &model.Ability{}))
	raw, err := os.ReadFile(filepath.Join("testdata", "reviewed_video_ui_documents.json"))
	require.NoError(t, err)
	fixtures := map[string]modelconfig.Document{}
	require.NoError(t, common.Unmarshal(raw, &fixtures))
	for index, provider := range []string{"aotian_video", "fenglang_video"} {
		t.Run(provider, func(t *testing.T) {
			document := fixtures[provider]
			require.Len(t, document.Bindings, 1)
			var name string
			for key := range document.Bindings {
				name = key
			}
			setting, err := common.Marshal(map[string]string{"task_plugin_key": provider})
			require.NoError(t, err)
			settingText := string(setting)
			channel := model.Channel{Id: index + 1, Type: 61, Name: "isolated UI save", Setting: &settingText, Key: "fixture-only-private-key", Models: "existing", Group: "default", Status: 2}
			require.NoError(t, db.Create(&channel).Error)
			require.NoError(t, db.Create(&model.Ability{ChannelId: channel.Id, Model: "existing", Group: "default", Enabled: false}).Error)
			require.NoError(t, db.Create(&model.TaskPlugin{Key: provider, Version: "2.1.0", APIVersion: 1, Active: true, Enabled: true}).Error)
			call := func(draft modelconfig.Document) *httptest.ResponseRecorder {
				payload, err := common.Marshal(channelConfigurationSave{Configuration: draft, AddModels: []string{name}, ExpectedModels: "existing"})
				require.NoError(t, err)
				recorder := httptest.NewRecorder()
				ctx, _ := gin.CreateTestContext(recorder)
				ctx.Params = gin.Params{{Key: "id", Value: fmt.Sprint(channel.Id)}}
				ctx.Set("id", 1)
				ctx.Request = httptest.NewRequest("PUT", "/api/channel/"+fmt.Sprint(channel.Id)+"/model-configuration", bytes.NewReader(payload))
				ctx.Request.Header.Set("Content-Type", "application/json")
				SaveChannelModelConfiguration(ctx)
				assert.NotContains(t, recorder.Body.String(), "fixture-only-private-key")
				return recorder
			}
			encoded, err := common.Marshal(document)
			require.NoError(t, err)
			for _, change := range []string{"remove prompt", "optional prompt", "ignore prompt", "spoof generated prompt"} {
				invalid := modelconfig.Document{}
				require.NoError(t, common.Unmarshal(encoded, &invalid))
				mode := invalid.Groups["actual-ui"].Modes["audio_ref"]
				parameter := mode.Parameters["prompt"]
				optional := false
				switch change {
				case "remove prompt":
					delete(mode.Parameters, "prompt")
				case "ignore prompt":
					mode.Mapping["prompt"] = "@ignore"
				default:
					parameter.Required = &optional
					if change == "spoof generated prompt" {
						parameter.Definition["serverGenerated"] = true
					}
					mode.Parameters["prompt"] = parameter
				}
				rejected := call(invalid)
				assert.Contains(t, rejected.Body.String(), `"success":false`, change)
				assert.Contains(t, rejected.Body.String(), "/prompt: required document rules must be retained", change)
			}
			accepted := call(document)
			var response struct {
				Success bool                 `json:"success"`
				Data    modelconfig.Document `json:"data"`
			}
			require.NoError(t, common.Unmarshal(accepted.Body.Bytes(), &response))
			require.True(t, response.Success, accepted.Body.String())
			assert.Equal(t, int64(1), response.Data.Revision)
			saved, err := model.GetChannelModelConfiguration(context.Background(), channel.Id, 0)
			require.NoError(t, err)
			assert.False(t, *saved.Groups["actual-ui"].Modes["audio_ref"].Parameters["model"].Required)
			require.NoError(t, db.First(&channel, channel.Id).Error)
			assert.Equal(t, "existing,"+name, channel.Models)
			assert.Equal(t, "fixture-only-private-key", channel.Key)
			assert.Equal(t, 2, channel.Status)
			var abilities []model.Ability
			require.NoError(t, db.Where("channel_id = ?", channel.Id).Find(&abilities).Error)
			assert.Len(t, abilities, 2)
		})
	}
}

func TestChannelModelConfigurationReviewedPluginVersion(t *testing.T) {
	previous := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	model.DB = db
	t.Cleanup(func() { model.DB = previous })
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.TaskPlugin{}))
	setting := `{"task_plugin_key":"yuxibox_media"}`
	baseURL := "https://yuxibox.cn"
	require.NoError(t, db.Create(&model.Channel{Id: 1, Type: 61, Name: "version regression", Setting: &setting, BaseURL: &baseURL, Key: "secret-must-not-appear", Status: 1}).Error)
	source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", "yuxibox_media.plugin.js"))
	require.NoError(t, err)
	compiled, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{Key: "yuxibox_media"})
	require.NoError(t, err)
	require.Equal(t, "2.1.5", compiled.Meta.Version)
	plugin := model.TaskPlugin{Key: "yuxibox_media", APIVersion: 1, Version: compiled.Meta.Version, Source: model.LongText(source), Active: true, Enabled: true}
	require.NoError(t, db.Create(&plugin).Error)
	name := "seedance-2.0（YX）"
	contract, err := modelconfig.InterfaceContract("yuxibox_media", "interface:cd545ac5f694b3b2", name)
	require.NoError(t, err)
	parameters := map[string]modelconfig.Parameter{}
	raw, err := common.Marshal(contract["parameters"])
	require.NoError(t, err)
	require.NoError(t, common.Unmarshal(raw, &parameters))
	mapping := map[string]string{}
	for field := range parameters {
		mapping[field] = field
	}
	draft := modelconfig.Empty("yuxibox_media")
	draft.Groups["g"] = modelconfig.Group{Modes: map[string]modelconfig.Mode{"text_video": {Enabled: true, StrictMapping: true, Input: map[string]any{}, Parameters: parameters, Mapping: mapping}}}
	draft.Bindings[name] = map[string]modelconfig.Binding{"text_video": {GroupID: "g", Protocol: &modelconfig.ProtocolBinding{TemplateModel: "interface:cd545ac5f694b3b2"}}}
	for _, version := range []string{"2.1.5", "2.1.99"} {
		t.Run(version, func(t *testing.T) {
			fixture := strings.ReplaceAll(string(source), `"2.1.5"`, `"`+version+`"`)
			require.NoError(t, db.Model(&plugin).Updates(map[string]any{"version": version, "source": fixture}).Error)
			raw, err := common.Marshal(map[string]any{"configuration": draft, "model": name, "mode": "text_video", "input": map[string]any{"model": name, "prompt": "offline version regression"}})
			require.NoError(t, err)
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Params = gin.Params{{Key: "id", Value: "1"}}
			c.Request = httptest.NewRequest("POST", "/api/channel/1/model-configuration/check", bytes.NewReader(raw))
			c.Request.Header.Set("Content-Type", "application/json")
			CheckChannelModelConfiguration(c)
			var response map[string]any
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			require.NotContains(t, recorder.Body.String(), "secret-must-not-appear")
			if version == "2.1.5" {
				require.Equal(t, true, response["success"], response)
				data := response["data"].(map[string]any)
				require.Equal(t, false, data["actualCall"])
				require.Contains(t, recorder.Body.String(), name)
				return
			}
			require.Equal(t, false, response["success"], response)
			params := response["message_params"].(map[string]any)
			require.Equal(t, "plugin_version", params["field"])
			require.Equal(t, version, params["version"])
			require.Equal(t, name, params["model"])
			require.Contains(t, response["message_key"], "update the host and plugin to compatible versions")
			require.NotContains(t, response["message_key"], "select a documented interface")
		})
	}
	for _, version := range []string{"2.0.0", "2.0.1", "2.0.2", "2.1.0", "2.1.1", "2.1.2", "2.1.3", "2.1.4", "2.1.5", "2.1.6", "2.1.7"} {
		require.True(t, modelconfig.ReviewedPluginVersion(version), version)
	}
	for _, version := range []string{"", "1.0.0", "2.1.8", "3.0.0", "2.1.4-preview", "2.1.6-beta.1", "2.1.7-beta.1"} {
		require.False(t, modelconfig.ReviewedPluginVersion(version), version)
	}
}

func TestChannelModelConfigurationControllerBoundary(t *testing.T) {
	previous := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	model.DB = db
	t.Cleanup(func() { model.DB = previous })
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.ChannelModelConfiguration{}, &model.TaskPlugin{}))
	setting := `{"task_plugin_key":"paisio_media"}`
	require.NoError(t, db.Create(&model.Channel{Id: 1, Type: 61, Name: "isolated", Setting: &setting, Key: "isolated-secret-must-not-appear", Models: "existing", Status: 1}).Error)
	document := modelconfig.Empty("paisio_media")
	document.Groups["g"] = modelconfig.Group{Name: "group", Modes: map[string]modelconfig.Mode{"text_image": {Enabled: true, Input: map[string]any{"n": float64(1)}}}}
	document.Bindings["m"] = map[string]modelconfig.Binding{"text_image": {GroupID: "g"}}
	call := func(handler gin.HandlerFunc, payload any) *httptest.ResponseRecorder {
		raw, marshalErr := common.Marshal(payload)
		require.NoError(t, marshalErr)
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Params = gin.Params{{Key: "id", Value: "1"}}
		c.Set("id", 1)
		c.Request = httptest.NewRequest("POST", "/api/channel/1/model-configuration", bytes.NewReader(raw))
		c.Request.Header.Set("Content-Type", "application/json")
		handler(c)
		require.NotContains(t, recorder.Body.String(), "isolated-secret-must-not-appear")
		return recorder
	}
	saved := call(SaveChannelModelConfiguration, channelConfigurationSave{Configuration: document})
	require.Contains(t, saved.Body.String(), `"revision":1`)
	conflict := call(SaveChannelModelConfiguration, channelConfigurationSave{Configuration: document})
	require.Equal(t, 409, conflict.Code)
	restored := call(RestoreChannelModelConfiguration, map[string]any{"revision": 1, "expectedRevision": 1})
	require.Contains(t, restored.Body.String(), `"revision":2`)
	require.NoError(t, db.Create(&model.TaskPlugin{Key: "paisio_media", APIVersion: 1, Version: "1.0.0", Active: true, Enabled: true, Source: model.LongText(`
 export const meta={apiVersion:1,key:"paisio_media",name:"Boundary test",version:"1.0.0",author:{name:"test"},models:["m"],fetchMode:"per_task",protocols:[{name:"openai_image",models:["m"]}]};
 export const protocols={openai_image:{decodeRequest:function(ctx){return {requestBody:{operation:"image_generate",input:ctx.body.value,uploads:[]}}},render:function(){return {data:[]}}}};
 export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/v1/images/generations",method:"POST",headers:{Authorization:"Bearer "+ctx.apiKey},body:ctx.requestBody.input};}
 export function parseSubmitResponse(){return {taskId:"test"}};export function buildQueryRequest(){return {url:"https://example.com"}};export function parseTaskResult(){return {status:"UNKNOWN"}};
 `)}).Error)
	fixture, fixtureErr := model.GetTaskPluginVersion("paisio_media", "")
	require.NoError(t, fixtureErr)
	_, fixtureErr = jsplugin.NewRegistry().Register(string(fixture.Source), jsplugin.Options{Key: "paisio_media"})
	require.NoError(t, fixtureErr)
	checked := call(CheckChannelModelConfiguration, map[string]any{"configuration": document, "model": "m", "mode": "text_image", "input": map[string]any{"prompt": "fixture"}})
	require.Contains(t, checked.Body.String(), `"actualCall":false`)
	mismatch := call(CheckChannelModelConfiguration, map[string]any{"configuration": document, "model": "m", "mode": "frames", "input": map[string]any{"prompt": "fixture"}})
	require.Contains(t, mismatch.Body.String(), `"success":false`)
	require.NotContains(t, mismatch.Body.String(), `"actualCall":false`)

	require.NotContains(t, checked.Body.String(), "configuration-check-placeholder")
	require.NotContains(t, checked.Body.String(), "Authorization")
	var row model.Channel
	require.NoError(t, db.First(&row, 1).Error)
	require.Equal(t, "isolated-secret-must-not-appear", row.Key)
	require.Equal(t, "existing", row.Models)
	// Metadata and offline request checking must consume the same installed
	// interface contract, without publishing its example model list.
	source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", "paisio_media.plugin.js"))
	require.NoError(t, err)
	compiled, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{Key: "paisio_media"})
	require.NoError(t, err)
	require.NoError(t, db.Model(&model.TaskPlugin{}).Where("id = ?", fixture.Id).Updates(map[string]any{"version": compiled.Meta.Version, "source": string(source), "source_hash": compiled.SourceSHA256}).Error)
	previousRegistry := jsplugin.DefaultRegistry
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	t.Cleanup(func() { jsplugin.DefaultRegistry = previousRegistry })
	_, err = jsplugin.DefaultRegistry.Register(string(source), jsplugin.Options{Key: "paisio_media"})
	require.NoError(t, err)
	options := call(GetTaskPluginOptions, nil)
	require.Contains(t, options.Body.String(), `"requiresModelDiscovery":true`)
	response := call(GetChannelModelConfiguration, nil)
	require.Contains(t, response.Body.String(), `"models":{}`)
	require.Contains(t, response.Body.String(), `"interfaces":{`)
	for id, raw := range compiled.Meta.ParameterInterfaces {
		entry := raw.(map[string]any)
		if entry["path"] != "/v1/videos" {
			continue
		}
		draft := modelconfig.Empty("paisio_media")
		parameters := map[string]modelconfig.Parameter{}
		mapping := map[string]string{}
		for field, raw := range entry["parameters"].(map[string]any) {
			data, _ := common.Marshal(raw)
			var parameter modelconfig.Parameter
			require.NoError(t, common.Unmarshal(data, &parameter))
			meta := parameter.Definition["x-channel-parameter"].(map[string]any)
			if meta["capabilities"].([]any)[0] != "base" {
				continue
			}
			parameters[field] = parameter
			mapping[field] = field
		}
		draft.Groups["g"] = modelconfig.Group{Name: "Document request fields", Modes: map[string]modelconfig.Mode{"text_video": {Enabled: true, StrictMapping: true, Input: map[string]any{}, Parameters: parameters, Mapping: mapping}}}
		draft.Bindings["actual-fetched-only"] = map[string]modelconfig.Binding{"text_video": {GroupID: "g", Protocol: &modelconfig.ProtocolBinding{TemplateModel: id, Confirmed: true}}}
		checked = call(CheckChannelModelConfiguration, map[string]any{"configuration": draft, "model": "actual-fetched-only", "mode": "text_video", "input": map[string]any{"prompt": "fixture", "duration": float64(6)}})
		require.Contains(t, checked.Body.String(), `"actualCall":false`)
		require.Contains(t, checked.Body.String(), `"duration":6`)
		require.Contains(t, checked.Body.String(), `actual-fetched-only`)
		// Other models and shared modes must not block this model's offline check.
		draft.Bindings["actual-fetched-only"]["text_video"].Protocol.Confirmed = false
		group := draft.Groups["g"]
		group.Modes["text_image"] = modelconfig.Mode{Protocol: &modelconfig.ProtocolBinding{TemplateModel: "other-invalid-interface"}}
		draft.Bindings["other-unconfirmed-model"] = map[string]modelconfig.Binding{"text_image": {GroupID: "g", Protocol: &modelconfig.ProtocolBinding{TemplateModel: "other-invalid-interface"}}}
		check := func(input map[string]any) map[string]any {
			t.Helper()
			result := call(CheckChannelModelConfiguration, map[string]any{"configuration": draft, "model": "actual-fetched-only", "mode": "text_video", "input": input})
			var response map[string]any
			require.NoError(t, common.Unmarshal(result.Body.Bytes(), &response))
			return response
		}
		input := map[string]any{"prompt": "fixture", "duration": float64(6)}
		require.Equal(t, true, check(input)["success"])
		require.False(t, draft.Bindings["actual-fetched-only"]["text_video"].Protocol.Confirmed)
		require.Error(t, modelconfig.Validate(draft))
		draft.Revision = 2
		saveUnconfirmed := call(SaveChannelModelConfiguration, channelConfigurationSave{Configuration: draft, ExpectedRevision: 2})
		require.Contains(t, saveUnconfirmed.Body.String(), `"success":false`)
		require.Contains(t, saveUnconfirmed.Body.String(), `"message_key":"Model {{model}} / field protocol:`)
		var unchanged model.ChannelModelConfiguration
		require.NoError(t, db.Where("channel_id = ?", 1).Order("revision DESC").First(&unchanged).Error)
		require.Equal(t, int64(2), unchanged.Revision)
		var revisions int64
		require.NoError(t, db.Model(&model.ChannelModelConfiguration{}).Where("channel_id = ?", 1).Count(&revisions).Error)
		require.Equal(t, int64(2), revisions)
		// Exercise the actual installed JS codec, not merely Resolve: without the
		// forwarded policy it would still reject 77 outside the documented range.
		parameter := parameters["seconds"]
		parameter.Definition["x-business-allowed-values"] = "unlimited"
		parameters["seconds"] = parameter
		input["duration"] = float64(77)
		unrestricted := check(input)
		require.Equal(t, true, unrestricted["success"], unrestricted)
		data, _ := common.Marshal(unrestricted["data"])
		require.Contains(t, string(data), `"duration":77`)
		// An individual model's explicit restriction overrides the common policy.
		binding := draft.Bindings["actual-fetched-only"]["text_video"]
		binding.Parameters = map[string]modelconfig.Parameter{"seconds": {Type: "integer", Enum: []any{float64(5)}}}
		draft.Bindings["actual-fetched-only"]["text_video"] = binding
		restricted := check(input)
		require.Equal(t, false, restricted["success"])
		require.Equal(t, "seconds", restricted["message_params"].(map[string]any)["field"])
		// Individual no-restrictions also works without the shared flag.
		delete(parameter.Definition, "x-business-allowed-values")
		parameters["seconds"] = parameter
		individual := parameter
		individual.Definition = map[string]any{"type": "integer", "x-business-allowed-values": "unlimited"}
		binding.Parameters["seconds"] = individual
		require.Equal(t, true, check(input)["success"])
		for _, field := range []string{"resolution", "aspect_ration", "unrestrictedValueFields"} {
			input[field] = "client-value"
			filtered := check(input)
			require.Equal(t, true, filtered["success"], filtered)
			data := filtered["data"].(map[string]any)
			require.NotContains(t, data["resolvedInput"], field)
			wire, err := common.Marshal(data["request"])
			require.NoError(t, err)
			require.NotContains(t, string(wire), "client-value")
			delete(input, field)
		}
		delete(input, "prompt")
		require.Equal(t, "prompt", check(input)["message_params"].(map[string]any)["field"])
		input["prompt"], input["duration"] = "fixture", true
		require.Equal(t, false, check(input)["success"])
	}
	require.NoError(t, db.Model(&model.Channel{}).Where("id = ?", 1).Update("type", 1).Error)
	invalid := call(GetChannelModelConfiguration, nil)
	require.Contains(t, invalid.Body.String(), `"success":false`)
}

func TestChannelModelConfigurationUnifiedOptionalSavedInput(t *testing.T) {
	file := os.Getenv("UNIFIED_OPTIONAL_CONFIG_FILE")
	if file == "" {
		t.Skip("explicit saved configuration required for isolated replay")
	}
	raw, err := os.ReadFile(file)
	require.NoError(t, err)
	var doc modelconfig.Document
	require.NoError(t, common.Unmarshal(raw, &doc))
	before, err := common.Marshal(doc)
	require.NoError(t, err)
	previous := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	model.DB = db
	t.Cleanup(func() { model.DB = previous })
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.TaskPlugin{}))
	setting, baseURL := `{"task_plugin_key":"paisio_media"}`, "https://provider.invalid"
	require.NoError(t, db.Create(&model.Channel{Id: 13, Type: 61, Name: "isolated optional fixture", Setting: &setting, BaseURL: &baseURL, Key: "never-use-real-credentials", Status: 1}).Error)
	source, err := os.ReadFile(filepath.Join("..", "plugin-sources", "media-providers", "six-v2", "dist", "paisio_media.plugin.js"))
	require.NoError(t, err)
	require.NoError(t, db.Create(&model.TaskPlugin{Key: "paisio_media", APIVersion: 1, Version: "2.1.5", Source: model.LongText(source), Active: true, Enabled: true}).Error)
	name := "seedance2-4-2-fast-720p"
	for _, test := range []struct {
		name  string
		input map[string]any
		ok    bool
	}{
		{"absent", map[string]any{"prompt": "offline fixture", "seconds": 10, "aspect_ratio": "3:4"}, true},
		{"extra", map[string]any{"prompt": "offline fixture", "seconds": 10, "aspect_ratio": "3:4", "resolution": "720p"}, true},
		{"ignored-invalid", map[string]any{"prompt": "offline fixture", "seconds": 10, "aspect_ratio": "3:4", "resolution": map[string]any{"bad": true}, "watermark": false, "unknown": 0}, true},
		{"supported-invalid", map[string]any{"prompt": "offline fixture", "seconds": 11, "aspect_ratio": "3:4"}, false},
		{"required-absent", map[string]any{"seconds": 10}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw, err := common.Marshal(map[string]any{"configuration": doc, "model": name, "mode": "text_video", "input": test.input})
			require.NoError(t, err)
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Params = gin.Params{{Key: "id", Value: "13"}}
			c.Request = httptest.NewRequest("POST", "/api/channel/13/model-configuration/check", bytes.NewReader(raw))
			c.Request.Header.Set("Content-Type", "application/json")
			CheckChannelModelConfiguration(c)
			var response map[string]any
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			require.Equal(t, test.ok, response["success"], response)
			require.NotContains(t, recorder.Body.String(), "never-use-real-credentials")
			if !test.ok {
				return
			}
			data := response["data"].(map[string]any)
			require.Equal(t, false, data["actualCall"])
			input := data["resolvedInput"].(map[string]any)
			require.NotContains(t, input, "resolution")
			require.NotContains(t, input, "watermark")
			require.NotContains(t, input, "unknown")
			body := data["request"].(map[string]any)["body"].(map[string]any)
			require.Equal(t, float64(10), body["duration"])
			require.Equal(t, "3:4", body["aspect_ratio"])
			require.NotContains(t, body, "resolution")
		})
	}
	after, err := common.Marshal(doc)
	require.NoError(t, err)
	require.Equal(t, string(before), string(after))
}
