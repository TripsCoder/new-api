package model

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestSixConfigurationInitializationAtomicRestore(t *testing.T) {
	previous := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	DB = db
	t.Cleanup(func() { DB = previous })
	runSixConfigurationInitializationRehearsal(t)
}

func runSixConfigurationInitializationRehearsal(t *testing.T) {
	var err error
	require.NoError(t, DB.AutoMigrate(&Channel{}, &ChannelModelConfiguration{}, &TaskPlugin{}, &SixConfigurationInitializationRun{}, &Task{}))
	providers := []string{"paisio_media", "yuxibox_media", "xcmapi_media", "artbox_media", "lxmone_media", "zhangyuge_media"}
	plan := make([]SixConfigurationInitialization, 0, 6)
	for i, key := range providers {
		setting := `{"task_plugin_key":"` + key + `"}`
		id := i + 1
		require.NoError(t, DB.Create(&Channel{Id: id, Type: 61, Setting: &setting, Key: "preserve-test-only", Models: "preserve-models", Status: 1}).Error)
		require.NoError(t, DB.Create(&TaskPlugin{Key: key, Version: "2.0.0", APIVersion: 1, Source: "isolated fixture", SourceHash: strings.Repeat("a", 64), Active: true, Enabled: true}).Error)
		document := modelconfig.Empty(key)
		document.Groups["reviewed"] = modelconfig.Group{Name: "Reviewed", Modes: map[string]modelconfig.Mode{"text_image": {Enabled: true, Input: map[string]any{"n": float64(1)}}}}
		document.Bindings["test-model"] = map[string]modelconfig.Binding{"text_image": {GroupID: "reviewed"}}
		raw, err := common.Marshal(document)
		require.NoError(t, err)
		hash := sha256.Sum256(raw)
		plan = append(plan, SixConfigurationInitialization{ChannelID: id, Configuration: document, DocumentSHA256: hex.EncodeToString(hash[:]), PluginSHA256: strings.Repeat("a", 64)})
	}
	require.NoError(t, DB.Create(&Channel{Id: 100, Type: 1, Key: "other-key", Models: "other-model", Status: 2}).Error)
	// Last-channel mismatch must roll back earlier inserts as well.
	plan[5].PluginSHA256 = strings.Repeat("b", 64)
	_, err = ApplySixConfigurationInitialization(t.Context(), 1, plan)
	require.Error(t, err)
	var count int64
	require.NoError(t, DB.Model(&ChannelModelConfiguration{}).Count(&count).Error)
	require.Zero(t, count)
	plan[5].PluginSHA256 = strings.Repeat("a", 64)
	receipts, err := ApplySixConfigurationInitialization(t.Context(), 1, plan)
	require.NoError(t, err)
	require.Len(t, receipts, 6)

	repeat, err := ApplySixConfigurationInitialization(t.Context(), 1, plan)
	require.NoError(t, err)
	require.Equal(t, receipts, repeat)
	badReceipt := append([]SixConfigurationInitializationReceipt(nil), receipts...)
	badReceipt[5].AppliedRevision++
	require.ErrorIs(t, RestoreSixConfigurationInitialization(t.Context(), 1, badReceipt), ErrModelConfigurationConflict)
	for _, item := range receipts {
		current, err := GetChannelModelConfiguration(t.Context(), item.ChannelID, 0)
		require.NoError(t, err)
		require.Equal(t, int64(1), current.Revision)
	}
	require.NoError(t, RestoreSixConfigurationInitialization(t.Context(), 1, receipts))
	for _, item := range receipts {
		document, err := GetChannelModelConfiguration(t.Context(), item.ChannelID, 0)
		require.NoError(t, err)
		require.Equal(t, int64(2), document.Revision)
		require.Empty(t, document.Bindings)
	}
	require.NoError(t, RestoreSixConfigurationInitialization(t.Context(), 1, receipts))
	for _, item := range receipts {
		versions, err := ListChannelModelConfigurationVersions(t.Context(), item.ChannelID)
		require.NoError(t, err)
		require.Len(t, versions, 2)
	}
	for i := 1; i <= 6; i++ {
		var row Channel
		require.NoError(t, DB.First(&row, i).Error)
		require.Equal(t, "preserve-test-only", row.Key)
		require.Equal(t, "preserve-models", row.Models)
		require.Equal(t, 1, row.Status)
	}
	var other Channel
	require.NoError(t, DB.First(&other, 100).Error)
	require.Equal(t, "other-key", other.Key)
	require.Equal(t, 2, other.Status)
}
