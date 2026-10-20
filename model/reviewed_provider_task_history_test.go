package model

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/QuantumNous/new-api/constant"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"testing"
)

func TestReviewedProviderActivationBlocksMissingTaskExecutionSnapshot(t *testing.T) {
	previous := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	DB = db
	t.Cleanup(func() { DB = previous; connection, _ := db.DB(); _ = connection.Close() })
	require.NoError(t, db.AutoMigrate(&TaskPlugin{}, &Task{}))
	oldDigest, newDigest := sha256.Sum256([]byte("old-fixture")), sha256.Sum256([]byte("new-fixture"))
	oldHash, newHash := hex.EncodeToString(oldDigest[:]), hex.EncodeToString(newDigest[:])
	require.NoError(t, db.Create(&TaskPlugin{Key: "xcmapi_media", Version: "1.1.0", APIVersion: 1, Source: "old-fixture", SourceHash: oldHash, Active: true, Enabled: true}).Error)
	require.NoError(t, db.Create(&TaskPlugin{Key: "xcmapi_media", Version: "2.0.0", APIVersion: 1, Source: "new-fixture", SourceHash: newHash, Active: false, Enabled: true}).Error)
	task := Task{TaskID: "task_history_fixture", Platform: constant.TaskPlatform("xcmapi_media"), Status: TaskStatusInProgress}
	require.NoError(t, db.Create(&task).Error)
	history, err := InventoryReviewedProviderTaskHistory(t.Context(), "xcmapi_media")
	require.NoError(t, err)
	require.Equal(t, 1, history.MissingInflightSnapshot)
	require.Error(t, ActivateTaskPlugin("xcmapi_media", "2.0.0"))
	active, err := GetTaskPluginVersion("xcmapi_media", "")
	require.NoError(t, err)
	require.Equal(t, "1.1.0", active.Version)
	task.PrivateData.Execution = &TaskExecutionSnapshot{TaskPlugin: &TaskPluginSnapshot{Key: "xcmapi_media", Version: "1.1.0"}}
	require.NoError(t, db.Save(&task).Error)
	history, err = InventoryReviewedProviderTaskHistory(t.Context(), "xcmapi_media")
	require.NoError(t, err)
	require.Zero(t, history.MissingSnapshot)
	require.Equal(t, 1, history.Versions["1.1.0"])

	require.NoError(t, db.Model(&TaskPlugin{}).Where(map[string]any{"key": "xcmapi_media", "version": "1.1.0"}).Update("source", "damaged-source").Error)
	damaged, err := InventoryReviewedProviderTaskHistory(t.Context(), "xcmapi_media")
	require.NoError(t, err)
	require.Equal(t, 1, damaged.SourceDigestConflicts)
	require.Error(t, ActivateTaskPlugin("xcmapi_media", "2.0.0"))
	require.NoError(t, db.Model(&TaskPlugin{}).Where(map[string]any{"key": "xcmapi_media", "version": "1.1.0"}).Update("source", "old-fixture").Error)
	require.NoError(t, ActivateTaskPlugin("xcmapi_media", "2.0.0"))
	_, err = DeleteTaskPluginVersion("xcmapi_media", "1.1.0")
	require.Error(t, err)
	preserved, err := GetTaskPluginVersion("xcmapi_media", "1.1.0")
	require.NoError(t, err)
	require.Equal(t, oldHash, preserved.SourceHash)

	var stored Task
	require.NoError(t, db.First(&stored, task.ID).Error)
	require.Equal(t, "1.1.0", stored.PrivateData.Execution.TaskPlugin.Version)
}
