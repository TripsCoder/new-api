package model

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"gorm.io/gorm"
	"sort"
)

type SixConfigurationInitializationPreview struct {
	OperationKey   string                                         `json:"operationKey"`
	AlreadyApplied bool                                           `json:"alreadyApplied"`
	Channels       []SixConfigurationInitializationPreviewChannel `json:"channels"`
	Blockers       []string                                       `json:"blockers"`
}
type SixConfigurationInitializationPreviewChannel struct {
	ChannelID       int                         `json:"channelId"`
	Provider        string                      `json:"provider"`
	CurrentRevision int64                       `json:"currentRevision"`
	ChannelEnabled  bool                        `json:"channelEnabled"`
	PluginMatches   bool                        `json:"pluginMatches"`
	History         ReviewedProviderTaskHistory `json:"history"`
}

// Preview performs only SELECTs. Apply rechecks the same facts under locks.
func PreviewSixConfigurationInitialization(ctx context.Context, plan []SixConfigurationInitialization) (SixConfigurationInitializationPreview, error) {
	result := SixConfigurationInitializationPreview{Channels: []SixConfigurationInitializationPreviewChannel{}, Blockers: []string{}}
	if len(plan) != 6 {
		return result, errors.New("initialization requires exactly the six reviewed channels")
	}
	ordered := append([]SixConfigurationInitialization(nil), plan...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ChannelID < ordered[j].ChannelID })
	seen, ids := map[string]bool{}, map[int]bool{}
	for _, item := range ordered {
		if len(item.Configuration.Bindings) == 0 {
			result.Blockers = append(result.Blockers, "initialization requires reviewed actual model selections for "+item.Configuration.Provider)
		}
		if item.ChannelID <= 0 || ids[item.ChannelID] || !modelconfig.SupportedProvider(item.Configuration.Provider) || seen[item.Configuration.Provider] {
			return result, errors.New("select one distinct existing channel for each reviewed provider")
		}
		ids[item.ChannelID] = true
		seen[item.Configuration.Provider] = true
		if err := modelconfig.Validate(item.Configuration); err != nil {
			return result, err
		}
		raw, err := common.Marshal(item.Configuration)
		if err != nil {
			return result, err
		}
		hash := sha256.Sum256(raw)
		if item.DocumentSHA256 != hex.EncodeToString(hash[:]) || len(item.PluginSHA256) != 64 {
			return result, errors.New("initialization fingerprint is invalid")
		}
	}
	key, err := initializationOperationKey("apply", ordered)
	if err != nil {
		return result, err
	}
	result.OperationKey = key
	var prior SixConfigurationInitializationRun
	err = DB.WithContext(ctx).Where("operation_key = ?", key).First(&prior).Error
	if err == nil {
		result.AlreadyApplied = true
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return result, err
	}
	for _, item := range ordered {
		entry := SixConfigurationInitializationPreviewChannel{ChannelID: item.ChannelID, Provider: item.Configuration.Provider}
		var channel Channel
		if err := DB.WithContext(ctx).Select("id", "type", "setting", "status").First(&channel, item.ChannelID).Error; err != nil {
			return result, err
		}
		var setting struct {
			TaskPluginKey string `json:"task_plugin_key"`
		}
		if channel.Setting == nil || common.Unmarshal([]byte(*channel.Setting), &setting) != nil || channel.Type != 61 || setting.TaskPluginKey != entry.Provider {
			result.Blockers = append(result.Blockers, "channel binding does not match "+entry.Provider)
		}
		entry.ChannelEnabled = channel.Status == common.ChannelStatusEnabled
		document, err := GetChannelModelConfiguration(ctx, item.ChannelID, 0)
		if err == nil {
			entry.CurrentRevision = document.Revision
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return result, err
		}
		if !result.AlreadyApplied && entry.CurrentRevision != item.ExpectedRevision {
			result.Blockers = append(result.Blockers, "configuration revision changed for "+entry.Provider)
		}
		var plugin TaskPlugin
		err = DB.WithContext(ctx).Select("id", "version", "source_hash", "enabled").Where(map[string]any{"key": entry.Provider, "active": true}).First(&plugin).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return result, err
		}
		entry.PluginMatches = err == nil && modelconfig.ReviewedPluginVersion(plugin.Version) && plugin.Enabled && plugin.SourceHash == item.PluginSHA256
		if !result.AlreadyApplied && !entry.PluginMatches {
			result.Blockers = append(result.Blockers, "reviewed version 2 plugin is not active for "+entry.Provider)
		}
		entry.History, err = InventoryReviewedProviderTaskHistory(ctx, entry.Provider)
		if err != nil {
			return result, err
		}
		if !result.AlreadyApplied && entry.History.MissingSnapshot > 0 {
			result.Blockers = append(result.Blockers, "historical task execution version is missing for "+entry.Provider)
		}
		if !result.AlreadyApplied && (len(entry.History.MissingSourceVersions) > 0 || entry.History.SourceDigestConflicts > 0) {
			result.Blockers = append(result.Blockers, "historical plugin source proof is missing for "+entry.Provider)
		}
		result.Channels = append(result.Channels, entry)
	}
	return result, nil
}
