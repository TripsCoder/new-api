package model

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"gorm.io/gorm"
)

// ChannelModelConfiguration is append-only. Restoring creates another revision;
// channel credentials, billing history and task snapshots are never rewritten.
type ChannelModelConfiguration struct {
	ChannelID int      `json:"channelId" gorm:"primaryKey;autoIncrement:false"`
	Revision  int64    `json:"revision" gorm:"primaryKey;autoIncrement:false"`
	Payload   LongText `json:"-"`
	CreatedAt int64    `json:"createdAt"`
	ActorID   int      `json:"actorId"`
}

var ErrModelConfigurationConflict = errors.New("channel model configuration changed; reload before saving")

func GetChannelModelConfiguration(ctx context.Context, channelID int, revision int64) (modelconfig.Document, error) {
	return getChannelModelConfigurationWithDB(DB, ctx, channelID, revision)
}
func getChannelModelConfigurationWithDB(db *gorm.DB, ctx context.Context, channelID int, revision int64) (modelconfig.Document, error) {
	var row ChannelModelConfiguration
	query := db.WithContext(ctx).Where("channel_id = ?", channelID)
	if revision > 0 {
		query = query.Where("revision = ?", revision)
	}
	err := query.Order("revision DESC").First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return modelconfig.Document{}, err
	}
	if err != nil {
		return modelconfig.Document{}, err
	}
	var document modelconfig.Document
	if err = common.Unmarshal([]byte(row.Payload), &document); err != nil {
		return document, errors.New("saved channel model configuration is invalid")
	}
	return document, nil
}
func ListChannelModelConfigurationVersions(ctx context.Context, channelID int) ([]ChannelModelConfiguration, error) {
	rows := []ChannelModelConfiguration{}
	err := DB.WithContext(ctx).Select("channel_id, revision, created_at, actor_id").Where("channel_id = ?", channelID).Order("revision DESC").Limit(100).Find(&rows).Error
	return rows, err
}
func SaveChannelModelConfiguration(ctx context.Context, channelID, actorID int, document modelconfig.Document, expected int64, addBoundModels ...bool) (modelconfig.Document, error) {
	return saveChannelModelConfigurationWithDB(DB, ctx, channelID, actorID, document, expected, addBoundModels...)
}
func SaveChannelModelConfigurationRoutes(ctx context.Context, channelID, actorID int, document modelconfig.Document, expected int64, add bool, remove []string, expectedModels string, addModels ...[]string) (modelconfig.Document, error) {
	return saveChannelModelConfigurationWithRoutes(DB, ctx, channelID, actorID, document, expected, add, remove, expectedModels, addModels...)
}
func saveChannelModelConfigurationWithDB(db *gorm.DB, ctx context.Context, channelID, actorID int, document modelconfig.Document, expected int64, addBoundModels ...bool) (modelconfig.Document, error) {
	return saveChannelModelConfigurationWithRoutes(db, ctx, channelID, actorID, document, expected, len(addBoundModels) > 0 && addBoundModels[0], nil, "")
}
func saveChannelModelConfigurationWithRoutes(db *gorm.DB, ctx context.Context, channelID, actorID int, document modelconfig.Document, expected int64, addBoundModels bool, removeModels []string, expectedModels string, addModels ...[]string) (modelconfig.Document, error) {
	// Retire only explicitly removed bindings in the new revision. Historical
	// revisions and shared definitions remain available to pinned tasks.
	if len(removeModels) > 0 {
		document.Bindings = maps.Clone(document.Bindings)
		for _, name := range removeModels {
			delete(document.Bindings, name)
		}
	}
	if err := modelconfig.Validate(document); err != nil {
		return document, err
	}
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var channel Channel
		// Reuse the existing parent row as the serialization point. SQLite uses
		// its write transaction; the shared helper omits unsupported FOR UPDATE.
		if err := lockForUpdate(tx).Select([]string{"id", "type", "setting", "models", "group", "status", "priority", "weight", "tag"}).First(&channel, channelID).Error; err != nil {
			return err
		}
		var current ChannelModelConfiguration
		err := tx.Where("channel_id = ?", channelID).Order("revision DESC").First(&current).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if current.Revision != expected {
			return ErrModelConfigurationConflict
		}
		if len(addModels) > 0 && channel.Models != expectedModels {
			return ErrModelConfigurationConflict
		}
		if len(removeModels) > 0 {
			if channel.Models != expectedModels {
				return ErrModelConfigurationConflict
			}
			if len(removeModels) > 1000 {
				return errors.New("too many models to remove")
			}
			for _, name := range removeModels {
				if !slices.Contains(channel.GetModels(), name) {
					return errors.New("removed model is not in this channel")
				}
			}
			retained := []string{}
			for _, name := range channel.GetModels() {
				if !slices.Contains(removeModels, name) {
					retained = append(retained, name)
				}
			}
			channel.Models = strings.Join(retained, ",")
			if err := tx.Model(&Channel{}).Where("id = ?", channelID).Update("models", channel.Models).Error; err != nil {
				return err
			}
			if err := tx.Where("channel_id = ? AND model IN ?", channelID, removeModels).Delete(&Ability{}).Error; err != nil {
				return err
			}
		}
		if addBoundModels && (len(addModels) == 0 || len(addModels[0]) > 0) {
			if channel.Type != 61 || !channel.GetSetting().BindsTaskPlugin(document.Provider) {
				return errors.New("configuration provider does not match this task channel")
			}
			var active TaskPlugin
			if err := tx.Select("version").Where(&TaskPlugin{Key: document.Provider, Active: true, Enabled: true}).First(&active).Error; err != nil || !modelconfig.ReviewedPluginVersion(active.Version) {
				return errors.New("activate the reviewed version 2 plugin before adding routed models")
			}
			rawCatalog, err := modelconfig.ProviderCatalog(document.Provider)
			if err != nil {
				return err
			}
			catalog := rawCatalog.(map[string]any)["models"].(map[string]any)
			candidates := make([]string, 0, len(document.Bindings))
			if len(addModels) > 0 {
				if len(addModels[0]) > 1000 {
					return errors.New("too many models to add")
				}
				for _, name := range addModels[0] {
					if slices.Contains(removeModels, name) {
						continue
					}
					if _, ok := document.Bindings[name]; !ok {
						return common.NewMessage("Model {{model}} / field protocol: configure this model before adding it to channel routing", map[string]any{"model": name})
					}
					if !slices.Contains(candidates, name) {
						candidates = append(candidates, name)
					}
				}
			} else {
				// Legacy callers retain their explicit addBoundModels operation;
				// the editor always supplies its exact current batch, even empty.
				for name := range document.Bindings {
					candidates = append(candidates, name)
				}
			}
			additions := []string{}
			for _, name := range candidates {
				bindings := document.Bindings[name]
				if slices.Contains(removeModels, name) {
					continue
				}
				enabled := false
				for mode, binding := range bindings {
					definition := document.Groups[binding.GroupID].Modes[mode]
					if !definition.Enabled || binding.Enabled != nil && !*binding.Enabled {
						continue
					}
					entry, _ := catalog[name].(map[string]any)
					modes, _ := entry["modes"].(map[string]any)
					if _, documented := modes[mode]; !documented && modelconfig.ManualProtocolFor(document, name, mode) == nil {
						return errors.New("select and confirm an implemented protocol before adding an unknown routed model")
					}
					enabled = true
				}
				if enabled && !slices.Contains(channel.GetModels(), name) {
					additions = append(additions, name)
				}
			}
			sort.Strings(additions)
			if len(additions) > 0 {
				names := channel.GetModels()
				names = append(names, additions...)
				if err := tx.Model(&Channel{}).Where("id = ?", channelID).Update("models", strings.Join(names, ",")).Error; err != nil {
					return err
				}
				// Append only new abilities. Existing routes and their status remain intact.
				for _, name := range additions {
					for _, group := range strings.Split(channel.Group, ",") {
						ability := Ability{Group: group, Model: name, ChannelId: channelID, Enabled: channel.Status == common.ChannelStatusEnabled, Priority: channel.Priority, Weight: uint(channel.GetWeight()), Tag: channel.Tag}
						if err := tx.Where(&Ability{ChannelId: channelID, Model: name, Group: group}).FirstOrCreate(&ability).Error; err != nil {
							return err
						}
					}
				}
			}
		}
		for name := range document.Bindings {
			for _, operation := range []string{"video_generate", "image_generate"} {
				if _, _, _, err := modelconfig.UnifiedModel(document, name, operation); err != nil {
					return fmt.Errorf("model %s: %w", name, err)
				}
			}
		}
		document.Revision = current.Revision + 1
		raw, err := common.Marshal(document)
		if err != nil {
			return err
		}
		row := ChannelModelConfiguration{ChannelID: channelID, Revision: document.Revision, Payload: LongText(raw), CreatedAt: time.Now().Unix(), ActorID: actorID}
		if err = tx.Create(&row).Error; err != nil {
			return fmt.Errorf("save channel model configuration: %w", err)
		}
		return nil
	})
	return document, err
}
