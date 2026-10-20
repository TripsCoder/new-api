package main

import (
	"bytes"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"os"
	"path/filepath"
	"testing"
)

func TestMaintenanceCommandPreparePreviewApplyRestoreIsIdempotent(t *testing.T) {
	directory := t.TempDir()
	dbPath := filepath.Join(directory, "six-test.db")
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.TaskPlugin{}, &model.Task{}, &model.User{}, &model.ChannelModelConfiguration{}, &model.SixConfigurationInitializationRun{}))
	sourceRoot := filepath.Join("..", "..", "plugin-sources", "media-providers", "six-v2")
	var manifest struct {
		Plugins []struct {
			Key    string `json:"key"`
			SHA256 string `json:"sha256"`
		} `json:"plugins"`
	}
	require.NoError(t, readJSON(filepath.Join(sourceRoot, "dist", "manifest.json"), &manifest))
	channels := map[string]int{}
	drafts := map[string]modelconfig.Document{}
	for index, plugin := range manifest.Plugins {
		id := index + 1
		channels[plugin.Key] = id
		setting := `{"task_plugin_key":"` + plugin.Key + `"}`
		require.NoError(t, db.Create(&model.Channel{Id: id, Type: 61, Setting: &setting, Key: "preserve-original-test-key", Status: 1, Models: "existing-models"}).Error)
		source, err := os.ReadFile(filepath.Join(sourceRoot, "dist", plugin.Key+".plugin.js"))
		require.NoError(t, err)
		require.NoError(t, db.Create(&model.TaskPlugin{Key: plugin.Key, Version: "2.1.0", APIVersion: 1, Source: model.LongText(source), SourceHash: plugin.SHA256, Active: true, Enabled: true}).Error)
		document := modelconfig.Empty(plugin.Key)
		raw, err := modelconfig.ProviderCatalog(plugin.Key)
		require.NoError(t, err)
		for interfaceID, raw := range raw.(map[string]any)["interfaces"].(map[string]any) {
			entry := raw.(map[string]any)
			if entry["kind"] != "video" {
				continue
			}
			parameters := map[string]modelconfig.Parameter{}
			mapping := map[string]string{}
			for field, raw := range entry["parameters"].(map[string]any) {
				data, _ := common.Marshal(raw)
				var parameter modelconfig.Parameter
				require.NoError(t, common.Unmarshal(data, &parameter))
				if parameter.Definition["x-channel-parameter"].(map[string]any)["capabilities"].([]any)[0] != "base" {
					continue
				}
				parameters[field] = parameter
				mapping[field] = field
			}
			document.Groups["actual"] = modelconfig.Group{Name: "Reviewed actual model", Modes: map[string]modelconfig.Mode{"text_video": {Enabled: true, StrictMapping: true, Input: map[string]any{}, Parameters: parameters, Mapping: mapping}}}
			document.Bindings["actual-fetched-only"] = map[string]modelconfig.Binding{"text_video": {GroupID: "actual", Protocol: &modelconfig.ProtocolBinding{TemplateModel: interfaceID, Confirmed: true}}}
			break
		}
		drafts[plugin.Key] = document
	}
	require.NoError(t, db.Create(&model.User{Id: 17, Username: "maintenance-admin", AffCode: "maintenance-admin", Role: common.RoleRootUser, Status: common.UserStatusEnabled}).Error)
	connection, err := db.DB()
	require.NoError(t, err)
	require.NoError(t, connection.Close())
	channelPath, planPath := filepath.Join(directory, "channels.json"), filepath.Join(directory, "plan.json")
	raw, err := common.Marshal(channels)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(channelPath, raw, 0600))
	execute := func(args ...string) string {
		var output bytes.Buffer
		require.NoError(t, run(t.Context(), args, &output))
		require.NotContains(t, output.String(), "preserve-original-test-key")
		return output.String()
	}
	t.Setenv("SIX_CHANNEL_INITIALIZATION_DSN", dbPath)
	emptyPlan := filepath.Join(directory, "empty-plan.json")
	execute("--action", "prepare", "--source-dir", sourceRoot, "--channels", channelPath, "--plan", emptyPlan)
	require.Contains(t, execute("--action", "preview", "--database", "sqlite", "--plan", emptyPlan), "initialization requires reviewed actual model selections")
	var emptyRejected bytes.Buffer
	require.Error(t, run(t.Context(), []string{"--action", "apply", "--database", "sqlite", "--plan", emptyPlan, "--receipt", filepath.Join(directory, "empty-receipt.json"), "--actor", "17"}, &emptyRejected))
	draftsPath := filepath.Join(directory, "actual-drafts.json")
	raw, err = common.Marshal(map[string]any{"configurations": drafts})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(draftsPath, raw, 0600))
	require.Contains(t, execute("--action", "prepare", "--source-dir", sourceRoot, "--channels", channelPath, "--drafts", draftsPath, "--plan", planPath), "prepared-not-applied")
	require.Contains(t, execute("--action", "discover", "--database", "sqlite"), `"status":"read-only"`)
	require.Contains(t, execute("--action", "preview", "--database", "sqlite", "--plan", planPath), `"blockers":[]`)
	receipt1, receipt2 := filepath.Join(directory, "receipt1.json"), filepath.Join(directory, "receipt2.json")
	var rejected bytes.Buffer
	require.Error(t, run(t.Context(), []string{"--action", "apply", "--database", "sqlite", "--plan", planPath, "--receipt", receipt1, "--actor", "999"}, &rejected))
	require.Contains(t, execute("--action", "apply", "--database", "sqlite", "--plan", planPath, "--receipt", receipt1, "--actor", "17"), "applied-or-already-applied")
	require.Contains(t, execute("--action", "preview", "--database", "sqlite", "--plan", planPath), `"alreadyApplied":true`)
	execute("--action", "apply", "--database", "sqlite", "--plan", planPath, "--receipt", receipt2, "--actor", "17")
	first, err := os.ReadFile(receipt1)
	require.NoError(t, err)
	second, err := os.ReadFile(receipt2)
	require.NoError(t, err)
	require.Equal(t, string(first), string(second))
	execute("--action", "restore", "--database", "sqlite", "--receipt", receipt1, "--actor", "17")
	execute("--action", "restore", "--database", "sqlite", "--receipt", receipt1, "--actor", "17")
	db, err = gorm.Open(sqlite.Open(dbPath), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	connection, err = db.DB()
	require.NoError(t, err)
	defer connection.Close()
	var count int64
	require.NoError(t, db.Model(&model.ChannelModelConfiguration{}).Count(&count).Error)
	require.Equal(t, int64(12), count)
	require.NoError(t, db.Model(&model.SixConfigurationInitializationRun{}).Count(&count).Error)
	require.Equal(t, int64(2), count)
	var stored []model.Channel
	require.NoError(t, db.Find(&stored).Error)
	require.Len(t, stored, 6)
	for _, channel := range stored {
		require.Equal(t, "preserve-original-test-key", channel.Key)
		require.Equal(t, "existing-models", channel.Models)
		require.Equal(t, 1, channel.Status)
	}
}

func TestReadOnlyMaintenanceDoesNotCreateSQLiteDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "must-not-exist.db")
	t.Setenv("SIX_CHANNEL_INITIALIZATION_DSN", path)
	var output bytes.Buffer
	require.Error(t, run(t.Context(), []string{"--action", "discover", "--database", "sqlite"}, &output))
	_, err := os.Stat(path)
	require.True(t, os.IsNotExist(err))
}
