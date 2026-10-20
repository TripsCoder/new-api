package model

import (
	"context"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"os"
	"sort"
	"testing"
)

func TestChannelModelConfigurationRevisionsAndCredentialProtection(t *testing.T) {
	original := DB
	t.Cleanup(func() { DB = original })
	var err error
	DB, err = gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, DB.AutoMigrate(&Channel{}, &ChannelModelConfiguration{}))
	channel := Channel{Id: 41, Type: 61, Name: "test", Key: "test-only-unchanged", Models: "original", Status: 1}
	require.NoError(t, DB.Create(&channel).Error)
	d := modelconfig.Empty("paisio_media")
	saved, err := SaveChannelModelConfiguration(context.Background(), 41, 1, d, 0)
	require.NoError(t, err)
	require.Equal(t, int64(1), saved.Revision)
	_, err = SaveChannelModelConfiguration(context.Background(), 41, 1, d, 0)
	require.ErrorIs(t, err, ErrModelConfigurationConflict)
	saved.Groups["second"] = modelconfig.Group{Name: "two", Modes: map[string]modelconfig.Mode{}}
	saved, err = SaveChannelModelConfiguration(context.Background(), 41, 1, saved, 1)
	require.NoError(t, err)
	require.Equal(t, int64(2), saved.Revision)
	old, err := GetChannelModelConfiguration(context.Background(), 41, 1)
	require.NoError(t, err)
	require.Empty(t, old.Groups)
	restored, err := SaveChannelModelConfiguration(context.Background(), 41, 1, old, 2)
	require.NoError(t, err)
	require.Equal(t, int64(3), restored.Revision)
	var unchanged Channel
	require.NoError(t, DB.First(&unchanged, 41).Error)
	require.Equal(t, channel.Key, unchanged.Key)
	require.Equal(t, channel.Models, unchanged.Models)
	require.Equal(t, channel.Status, unchanged.Status)
	versions, err := ListChannelModelConfigurationVersions(context.Background(), 41)
	require.NoError(t, err)
	require.Len(t, versions, 3)
}

func TestChannelModelConfigurationApplyBatchAndRemoval(t *testing.T) {
	cases := map[string]gorm.Dialector{"sqlite": sqlite.Open(":memory:")}
	if dsn := os.Getenv("CHANNEL_APPLY_TEST_POSTGRES_DSN"); dsn != "" {
		require.Contains(t, dsn, "dbname=codex_model_apply_r18")
		cases["postgres"] = postgres.Open(dsn)
	}
	for name, dialect := range cases {
		t.Run(name, func(t *testing.T) {
			db, err := gorm.Open(dialect, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
			require.NoError(t, db.AutoMigrate(&Channel{}, &Ability{}, &ChannelModelConfiguration{}, &TaskPlugin{}))
			setting := `{"task_plugin_key":"paisio_media"}`
			channel := Channel{Id: 61, Type: 61, Key: "isolated-unchanged", Models: "keep,removed", Setting: &setting, Group: "default", Status: 1}
			require.NoError(t, db.Create(&channel).Error)
			other := Channel{Id: 62, Type: 61, Key: "other-unchanged", Models: "removed,other", Setting: &setting, Group: "default", Status: 1}
			require.NoError(t, db.Create(&other).Error)
			for _, ability := range []Ability{{ChannelId: 61, Model: "keep", Group: "default", Enabled: false}, {ChannelId: 61, Model: "removed", Group: "default", Enabled: true}, {ChannelId: 62, Model: "removed", Group: "default", Enabled: true}} {
				require.NoError(t, db.Create(&ability).Error)
			}
			require.NoError(t, db.Create(&TaskPlugin{Key: "paisio_media", Version: "2.1.1", Active: true, Enabled: true}).Error)
			raw, err := modelconfig.ProviderCatalog("paisio_media")
			require.NoError(t, err)
			interfaces := raw.(map[string]any)["interfaces"].(map[string]any)
			templates := []string{}
			for id, value := range interfaces {
				if _, ok := value.(map[string]any)["modes"].(map[string]any)["text_image"]; ok {
					templates = append(templates, id)
				}
			}
			sort.Strings(templates)
			require.NotEmpty(t, templates)
			doc := modelconfig.Empty("paisio_media")
			parameters := map[string]modelconfig.Parameter{}
			mapping := map[string]string{}
			for field, raw := range interfaces[templates[0]].(map[string]any)["parameters"].(map[string]any) {
				var parameter modelconfig.Parameter
				data, err := common.Marshal(raw)
				require.NoError(t, err)
				require.NoError(t, common.Unmarshal(data, &parameter))
				parameters[field] = parameter
				mapping[field] = field
			}
			doc.Groups["g"] = modelconfig.Group{Name: "shared", Modes: map[string]modelconfig.Mode{"text_image": {Enabled: true, Protocol: &modelconfig.ProtocolBinding{TemplateModel: templates[0], Confirmed: true}, Input: map[string]any{}, Parameters: parameters, Mapping: mapping}}}
			for _, id := range []string{"keep", "removed", "new", "historic", "disabled"} {
				doc.Bindings[id] = map[string]modelconfig.Binding{"text_image": {GroupID: "g"}}
			}
			no := false
			doc.Bindings["disabled"]["text_image"] = modelconfig.Binding{GroupID: "g", Enabled: &no}
			first, err := saveChannelModelConfigurationWithDB(db, context.Background(), 61, 1, doc, 0)
			require.NoError(t, err)
			apply := func(doc modelconfig.Document, snapshot string, add, remove []string) (modelconfig.Document, error) {
				return saveChannelModelConfigurationWithRoutes(db, context.Background(), 61, 1, doc, doc.Revision, true, remove, snapshot, add)
			}
			// A removed binding need not be confirmed merely to retire it.
			doc.Bindings["removed"]["text_image"] = modelconfig.Binding{GroupID: "g", Protocol: &modelconfig.ProtocolBinding{TemplateModel: templates[0]}}
			doc.Revision = first.Revision
			saved, err := apply(doc, "keep,removed", []string{"new", "removed", "disabled", "new"}, []string{"removed"})
			require.NoError(t, err)
			require.NotContains(t, saved.Bindings, "removed")
			require.Contains(t, doc.Bindings, "removed", "caller and old revisions remain untouched")
			var row Channel
			require.NoError(t, db.First(&row, 61).Error)
			require.Equal(t, "keep,new", row.Models)
			require.Equal(t, channel.Key, row.Key)
			var abilities []Ability
			require.NoError(t, db.Where("channel_id = ?", 61).Order("model").Find(&abilities).Error)
			require.Len(t, abilities, 2)
			require.Equal(t, "keep", abilities[0].Model)
			require.False(t, abilities[0].Enabled, "existing route status is preserved")
			require.Equal(t, "new", abilities[1].Model)
			require.True(t, abilities[1].Enabled)
			history, err := getChannelModelConfigurationWithDB(db, context.Background(), 61, first.Revision)
			require.NoError(t, err)
			require.Contains(t, history.Bindings, "removed")
			require.Equal(t, first.Groups, saved.Groups)
			require.Equal(t, first.Bindings["keep"], saved.Bindings["keep"])
			saved.Bindings["later"] = map[string]modelconfig.Binding{"text_image": {GroupID: "g"}}
			saved, err = apply(saved, "keep,new", []string{"later"}, nil)
			require.NoError(t, err)
			require.NoError(t, db.First(&row, 61).Error)
			require.Equal(t, "keep,new,later", row.Models, "neither retired nor unselected historical bindings are routed")
			// Even an explicitly restored historical configuration cannot cause
			// automatic routing when the current addition batch is empty.
			history.Revision = saved.Revision
			saved, err = apply(history, row.Models, []string{}, nil)
			require.NoError(t, err)
			require.NoError(t, db.First(&row, 61).Error)
			require.Equal(t, "keep,new,later", row.Models)
			beforeRevision := saved.Revision
			_, err = apply(saved, "outdated snapshot", []string{}, nil)
			require.ErrorIs(t, err, ErrModelConfigurationConflict)
			_, err = apply(saved, row.Models, []string{"unconfigured"}, []string{"new"})
			require.ErrorContains(t, err, "unconfigured")
			current, err := getChannelModelConfigurationWithDB(db, context.Background(), 61, 0)
			require.NoError(t, err)
			require.Equal(t, beforeRevision, current.Revision)
			require.NoError(t, db.First(&row, 61).Error)
			require.Equal(t, "keep,new,later", row.Models, "failed additions roll back removals and parameters together")
			// Removal-only still works when the provider plugin is unavailable.
			require.NoError(t, db.Model(&TaskPlugin{}).Where("key = ?", "paisio_media").Update("enabled", false).Error)
			saved, err = apply(current, row.Models, []string{}, []string{"new"})
			require.NoError(t, err)
			require.NoError(t, db.First(&row, 61).Error)
			require.Equal(t, "keep,later", row.Models)
			var untouched Channel
			require.NoError(t, db.First(&untouched, 62).Error)
			require.Equal(t, other.Models, untouched.Models)
			require.Equal(t, other.Key, untouched.Key)
			require.NoError(t, db.Where("channel_id = ? AND model = ?", 62, "removed").First(&Ability{}).Error)
		})
	}
}
