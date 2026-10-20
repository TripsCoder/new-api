package model

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sort"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"gorm.io/gorm"
)

// SixConfigurationInitialization is an explicit reviewed plan, not automatic
// startup migration. It never installs plugins or rewrites a channel record.
type SixConfigurationInitialization struct {
	ChannelID        int                  `json:"channelId"`
	ExpectedRevision int64                `json:"expectedRevision"`
	PluginSHA256     string               `json:"pluginSHA256"`
	DocumentSHA256   string               `json:"documentSHA256"`
	Configuration    modelconfig.Document `json:"configuration"`
}
type SixConfigurationInitializationReceipt struct {
	ChannelID       int                  `json:"channelId"`
	AppliedRevision int64                `json:"appliedRevision"`
	Before          modelconfig.Document `json:"before"`
}

// ApplySixConfigurationInitialization checks all six preconditions under one
// transaction. Missing channels, stale revisions, disabled/wrong plugin builds,
// or any invalid document leave every channel and revision unchanged.
func ApplySixConfigurationInitialization(ctx context.Context, actorID int, plan []SixConfigurationInitialization) ([]SixConfigurationInitializationReceipt, error) {
	if len(plan) != 6 {
		return nil, errors.New("initialization requires exactly the six reviewed channels")
	}
	ordered := append([]SixConfigurationInitialization(nil), plan...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ChannelID < ordered[j].ChannelID })
	seen := map[string]bool{}
	ids := map[int]bool{}
	for _, item := range ordered {
		if len(item.Configuration.Bindings) == 0 {
			return nil, errors.New("initialization requires reviewed actual model selections; empty discovery drafts cannot be applied")
		}
		if !modelconfig.SupportedProvider(item.Configuration.Provider) || seen[item.Configuration.Provider] || item.ChannelID <= 0 || ids[item.ChannelID] {
			return nil, errors.New("initialization must select one distinct channel for each reviewed provider")
		}
		seen[item.Configuration.Provider] = true
		ids[item.ChannelID] = true
		if err := modelconfig.Validate(item.Configuration); err != nil {
			return nil, err
		}
		raw, err := common.Marshal(item.Configuration)
		if err != nil {
			return nil, err
		}
		hash := sha256.Sum256(raw)
		if item.DocumentSHA256 != hex.EncodeToString(hash[:]) || len(item.PluginSHA256) != 64 {
			return nil, errors.New("initialization document or plugin fingerprint is invalid")
		}
	}
	operationKey, err := initializationOperationKey("apply", ordered)
	if err != nil {
		return nil, err
	}
	receipts := make([]SixConfigurationInitializationReceipt, 0, 6)
	err = DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Lock in one stable order before the first receipt lookup. This also
		// serializes identical retries on MySQL and PostgreSQL.
		for _, item := range ordered {
			var row Channel
			if err := lockForUpdate(tx).Select("id").First(&row, item.ChannelID).Error; err != nil {
				return err
			}
		}
		var prior SixConfigurationInitializationRun
		found := tx.Where("operation_key = ?", operationKey).First(&prior).Error
		if found == nil {
			return common.Unmarshal([]byte(prior.Result), &receipts)
		}
		if !errors.Is(found, gorm.ErrRecordNotFound) {
			return found
		}

		for _, item := range ordered {
			var channel Channel
			if err := lockForUpdate(tx).Select("id", "type", "setting").First(&channel, item.ChannelID).Error; err != nil {
				return err
			}
			var setting struct {
				TaskPluginKey string `json:"task_plugin_key"`
			}
			if channel.Setting == nil || common.Unmarshal([]byte(*channel.Setting), &setting) != nil || channel.Type != 61 || setting.TaskPluginKey != item.Configuration.Provider {
				return errors.New("initialization channel binding changed")
			}
			var plugin TaskPlugin
			if err := lockForUpdate(tx).Select("id", "key", "version", "source_hash", "active", "enabled").Where(map[string]any{"key": setting.TaskPluginKey, "active": true}).First(&plugin).Error; err != nil {
				return err
			}
			if !modelconfig.ReviewedPluginVersion(plugin.Version) || !plugin.Enabled || plugin.SourceHash != item.PluginSHA256 {
				return errors.New("the reviewed version 2 plugin build must be active before configuration initialization")
			}
			if err := guardReviewedProviderVersionReplacement(tx, setting.TaskPluginKey, plugin.Version); err != nil {
				return err
			}
			before, err := getChannelModelConfigurationWithDB(tx, ctx, item.ChannelID, 0)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				before = modelconfig.Empty(setting.TaskPluginKey)
			} else if err != nil {
				return err
			}
			saved, err := saveChannelModelConfigurationWithDB(tx, ctx, item.ChannelID, actorID, item.Configuration, item.ExpectedRevision)
			if err != nil {
				return err
			}
			receipts = append(receipts, SixConfigurationInitializationReceipt{ChannelID: item.ChannelID, AppliedRevision: saved.Revision, Before: before})
		}

		result, err := common.Marshal(receipts)
		if err != nil {
			return err
		}
		return tx.Create(&SixConfigurationInitializationRun{OperationKey: operationKey, Result: LongText(result), ActorID: actorID}).Error
	})
	if err != nil {
		return nil, err
	}
	return receipts, nil
}

// Restore appends revisions. An intervening operator edit causes an atomic
// conflict rather than overwriting it; history and task snapshots remain intact.
func RestoreSixConfigurationInitialization(ctx context.Context, actorID int, receipts []SixConfigurationInitializationReceipt) error {
	if len(receipts) != 6 {
		return errors.New("restore requires the complete six-channel receipt")
	}
	ordered := append([]SixConfigurationInitializationReceipt(nil), receipts...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ChannelID < ordered[j].ChannelID })
	seen := map[int]bool{}
	providers := map[string]bool{}
	for _, item := range ordered {
		if item.ChannelID <= 0 || seen[item.ChannelID] || !modelconfig.SupportedProvider(item.Before.Provider) || providers[item.Before.Provider] || item.AppliedRevision <= 0 {
			return errors.New("invalid initialization restore receipt")
		}
		seen[item.ChannelID] = true
		providers[item.Before.Provider] = true
	}

	operationKey, err := initializationOperationKey("restore", ordered)
	if err != nil {
		return err
	}
	return DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, item := range ordered {
			var row Channel
			if err := lockForUpdate(tx).Select("id").First(&row, item.ChannelID).Error; err != nil {
				return err
			}
		}
		var prior SixConfigurationInitializationRun
		found := tx.Where("operation_key = ?", operationKey).First(&prior).Error
		if found == nil {
			return nil
		}
		if !errors.Is(found, gorm.ErrRecordNotFound) {
			return found
		}

		for _, item := range ordered {
			var channel Channel
			if err := lockForUpdate(tx).Select("id", "type", "setting").First(&channel, item.ChannelID).Error; err != nil {
				return err
			}
			var setting struct {
				TaskPluginKey string `json:"task_plugin_key"`
			}
			if channel.Setting == nil || common.Unmarshal([]byte(*channel.Setting), &setting) != nil || channel.Type != 61 || setting.TaskPluginKey != item.Before.Provider {
				return errors.New("initialization restore channel binding changed")
			}
			if _, err := saveChannelModelConfigurationWithDB(tx, ctx, item.ChannelID, actorID, item.Before, item.AppliedRevision); err != nil {
				return err
			}
		}
		return tx.Create(&SixConfigurationInitializationRun{OperationKey: operationKey, Result: LongText(`{"restored":true}`), ActorID: actorID}).Error
	})
}

// SixConfigurationInitializationRun is committed with the six revisions. Its
// content-derived operation key makes exact apply/restore retries return the
// original result even after an uncertain client response.
type SixConfigurationInitializationRun struct {
	OperationKey string `gorm:"primaryKey;size:80"`
	Result       LongText
	ActorID      int
}

func initializationOperationKey(kind string, value any) (string, error) {
	raw, err := common.Marshal(value)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(raw)
	return kind + ":" + hex.EncodeToString(hash[:]), nil
}
