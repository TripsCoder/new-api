package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"testing"
)

func TestPinnedProviderTaskKeepsHistoricalExecutionSource(t *testing.T) {
	oldDB, oldRegistry := model.DB, pluginruntime.DefaultRegistry
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	model.DB = database
	pluginruntime.DefaultRegistry = pluginruntime.NewRegistry()
	t.Cleanup(func() {
		model.DB = oldDB
		pluginruntime.DefaultRegistry = oldRegistry
		connection, _ := database.DB()
		connection.Close()
		historicalPlugins.Lock()
		historicalPlugins.entries = map[string]historicalPluginEntry{}
		historicalPlugins.Unlock()
	})
	require.NoError(t, database.AutoMigrate(&model.TaskPlugin{}))
	source := func(version, path string) string {
		return fmt.Sprintf(`export const meta={apiVersion:1,key:"paisio_media",name:"Pinned",version:%q,author:{name:"test"},models:["m"],fetchMode:"per_task"};export function buildSubmitRequest(){return {url:"https://example.com/submit"}};export function parseSubmitResponse(){return {taskId:"x"}};export function buildQueryRequest(ctx){return {url:"https://example.com/%s/"+ctx.taskId}};export function parseTaskResult(){return {status:"UNKNOWN"}};`, version, path)
	}
	prior := source("1.0.0", "old")
	digest := sha256.Sum256([]byte(prior))
	hash := hex.EncodeToString(digest[:])
	require.NoError(t, database.Create(&model.TaskPlugin{Key: "paisio_media", Version: "1.0.0", APIVersion: 1, Source: model.LongText(prior), SourceHash: hash, Active: false, Enabled: false}).Error)
	active, err := pluginruntime.DefaultRegistry.Register(source("2.0.0", "new"), pluginruntime.Options{})
	require.NoError(t, err)
	task := &model.Task{Platform: constant.TaskPlatform("paisio_media")}
	task.PrivateData.Execution = &model.TaskExecutionSnapshot{TaskPlugin: &model.TaskPluginSnapshot{Key: "paisio_media", Version: "1.0.0", SourceSHA256: hash}}
	historical, err := ResolvePinnedTaskPlugin(task)
	require.NoError(t, err)
	require.Equal(t, "1.0.0", historical.Meta.Version)
	var request map[string]any
	require.NoError(t, historical.Engine.CallInto(context.Background(), &request, "buildQueryRequest", map[string]any{"taskId": "accepted-task"}))
	require.Equal(t, "https://example.com/old/accepted-task", request["url"])
	current, ok := pluginruntime.DefaultRegistry.Get("paisio_media")
	require.True(t, ok)
	require.Same(t, active, current)
	task.PrivateData.Execution.TaskPlugin.Version = "9.9.9"
	_, err = ResolvePinnedTaskPlugin(task)
	require.Error(t, err, "missing history must not use current source")
	task.PrivateData.Execution.TaskPlugin.Version = "1.0.0"
	task.PrivateData.Execution.TaskPlugin.SourceSHA256 = "wrong"
	_, err = ResolvePinnedTaskPlugin(task)
	require.Error(t, err)
	task.PrivateData.Execution.TaskPlugin.SourceSHA256 = hash
	pluginruntime.DefaultRegistry.SetEnabled(false)
	_, err = ResolvePinnedTaskPlugin(task)
	require.Error(t, err, "global plugin disable must still apply")
}

func TestVersionOnlyLegacySnapshotRequiresRetainedImmutableSource(t *testing.T) {
	oldDB, oldRegistry := model.DB, pluginruntime.DefaultRegistry
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	model.DB = db
	pluginruntime.DefaultRegistry = pluginruntime.NewRegistry()
	t.Cleanup(func() {
		model.DB = oldDB
		pluginruntime.DefaultRegistry = oldRegistry
		connection, _ := db.DB()
		_ = connection.Close()
		historicalPlugins.Lock()
		historicalPlugins.entries = map[string]historicalPluginEntry{}
		historicalPlugins.Unlock()
	})
	require.NoError(t, db.AutoMigrate(&model.TaskPlugin{}))
	source := func(version, path string) string {
		return fmt.Sprintf(`export const meta={apiVersion:1,key:"yuxibox_media",name:"Legacy proof",version:%q,author:{name:"test"},models:["m"],fetchMode:"per_task"};export function buildSubmitRequest(){return {url:"https://example.com/submit"}};export function parseSubmitResponse(){return {taskId:"x"}};export function buildQueryRequest(){return {url:"https://example.com/%s"}};export function parseTaskResult(){return {status:"UNKNOWN"}};`, version, path)
	}
	retained := source("1.0.0", "retained-original")
	digest := sha256.Sum256([]byte(retained))
	hash := hex.EncodeToString(digest[:])
	require.NoError(t, db.Create(&model.TaskPlugin{Key: "yuxibox_media", Version: "1.0.0", APIVersion: 1, Source: model.LongText(retained), SourceHash: hash}).Error)
	_, err = pluginruntime.DefaultRegistry.Register(source("1.0.0", "changed-current"), pluginruntime.Options{})
	require.NoError(t, err)
	task := &model.Task{Platform: constant.TaskPlatform("yuxibox_media"), PrivateData: model.TaskPrivateData{Execution: &model.TaskExecutionSnapshot{TaskPlugin: &model.TaskPluginSnapshot{Key: "yuxibox_media", Version: "1.0.0"}}}}
	loaded, err := ResolvePinnedTaskPlugin(task)
	require.NoError(t, err)
	require.Equal(t, hash, loaded.SourceSHA256)
	var descriptor map[string]any
	require.NoError(t, loaded.Engine.CallInto(t.Context(), &descriptor, "buildQueryRequest", map[string]any{}))
	require.Equal(t, "https://example.com/retained-original", descriptor["url"])
	_, err = pluginruntime.DefaultRegistry.Register(source("1.0.2", "unproven-current"), pluginruntime.Options{})
	require.NoError(t, err)
	task.PrivateData.Execution.TaskPlugin.Version = "1.0.2"
	_, err = ResolvePinnedTaskPlugin(task)
	require.Error(t, err, "same-version current source is not proof for a version-only legacy task")
}
