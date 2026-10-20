package model

import (
	"context"
	"fmt"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgreSQLWorkflowRemovalPreviewSaveAtomicity(t *testing.T) {
	dsn := os.Getenv("PAGE_WORKFLOW_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not supplied")
	}
	require.Contains(t, dsn, "port=54378")
	require.Contains(t, dsn, "dbname=page_workflow_test")
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent), NamingStrategy: schema.NamingStrategy{TablePrefix: fmt.Sprintf("wf%x_", time.Now().UnixNano())}})
	require.NoError(t, err)
	oldDB := DB
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	DB = db
	common.SetDatabaseTypes(common.DatabaseTypePostgreSQL, common.DatabaseTypePostgreSQL)
	initCol()
	t.Cleanup(func() {
		require.NoError(t, db.Migrator().DropTable(&ChannelModelConfiguration{}, &Ability{}, &Channel{}))
		DB = oldDB
		common.SetDatabaseTypes(oldMain, oldLog)
		initCol()
	})
	require.NoError(t, db.AutoMigrate(&Channel{}, &Ability{}, &ChannelModelConfiguration{}))
	setting := `{"task_plugin_key":"yuxibox_media"}`
	ch := Channel{Id: 901, Type: 61, Models: "kept,absent", Status: 1, Key: "fixture-only", Setting: &setting, Group: "default"}
	require.NoError(t, db.Create(&ch).Error)
	for _, name := range []string{"kept", "absent"} {
		require.NoError(t, db.Create(&Ability{ChannelId: 901, Model: name, Group: "default", Enabled: true}).Error)
	}
	doc := modelconfig.Empty("yuxibox_media")
	doc, err = SaveChannelModelConfiguration(context.Background(), 901, 1, doc, 0)
	require.NoError(t, err)
	next, err := SaveChannelModelConfigurationRoutes(context.Background(), 901, 1, doc, doc.Revision, false, []string{"absent"}, "kept,absent")
	require.NoError(t, err)
	require.Equal(t, int64(2), next.Revision)
	var saved Channel
	require.NoError(t, db.First(&saved, 901).Error)
	require.Equal(t, "kept", saved.Models)
	require.Equal(t, ch.Key, saved.Key)
	require.Equal(t, ch.Status, saved.Status)
	var count int64
	require.NoError(t, db.Model(&Ability{}).Where("channel_id = ? AND model = ?", 901, "absent").Count(&count).Error)
	require.Zero(t, count)
	require.NoError(t, db.Model(&Ability{}).Where("channel_id = ? AND model = ?", 901, "kept").Count(&count).Error)
	require.Equal(t, int64(1), count)
	// A concurrent model-list edit or unknown removal rolls back the revision and routes together.
	_, err = SaveChannelModelConfigurationRoutes(context.Background(), 901, 1, next, next.Revision, false, []string{"kept"}, "kept,absent")
	require.ErrorIs(t, err, ErrModelConfigurationConflict)
	_, err = SaveChannelModelConfigurationRoutes(context.Background(), 901, 1, next, next.Revision, false, []string{"other-channel"}, "kept")
	require.ErrorContains(t, err, "not in this channel")
	current, err := GetChannelModelConfiguration(context.Background(), 901, 0)
	require.NoError(t, err)
	require.Equal(t, next.Revision, current.Revision)
	require.NoError(t, db.First(&saved, 901).Error)
	require.Equal(t, "kept", saved.Models)
}
func TestCapabilityLegalSubsetsKeepExplicitMappingAndHardConstraints(t *testing.T) {
	doc := modelconfig.Empty("yuxibox_media")
	doc.Groups["g"] = modelconfig.Group{Name: "documented capabilities", Modes: map[string]modelconfig.Mode{}}
	doc.Bindings["model"] = map[string]modelconfig.Binding{}
	yes := true
	no := false
	for _, key := range []string{"text_video", "image_video", "video_ref", "audio_ref", "mixed_ref"} {
		doc.Groups["g"].Modes[key] = modelconfig.Mode{Enabled: true, Input: map[string]any{}, Parameters: map[string]modelconfig.Parameter{"prompt": {Type: "string", Required: &yes}, "images": {Type: "array", Required: &no}, "videos": {Type: "array", Required: &no}, "audios": {Type: "array", Required: &no}, "resolution": {Type: "string", Enum: []any{"720p", "1080p"}}}, Mapping: map[string]string{"unsupported": "@reject", "optional_extension": "@ignore"}, Cost: modelconfig.Cost{}}
		doc.Bindings["model"][key] = modelconfig.Binding{GroupID: "g"}
	}
	cases := []map[string]any{{"prompt": "only text"}, {"prompt": "image", "images": []any{"https://media.example/image.png"}}, {"prompt": "video", "videos": []any{"https://media.example/video.mp4"}}, {"prompt": "audio", "audios": []any{"https://media.example/audio.mp3"}}, {"prompt": "mixed", "videos": []any{"https://media.example/video.mp4"}, "audios": []any{"https://media.example/audio.mp3"}}}
	for _, input := range cases {
		mode, err := modelconfig.InferConfiguredMode(doc, "model", "video_generate", input, nil)
		require.NoError(t, err)
		out, _, err := modelconfig.Resolve(doc, "model", mode, input)
		require.NoError(t, err)
		require.Equal(t, input, out)
		for _, key := range []string{"images", "videos", "audios"} {
			if _, present := input[key]; !present {
				_, added := out[key]
				require.False(t, added)
			}
		}
	}
	_, _, err := modelconfig.Resolve(doc, "model", "text_video", map[string]any{"prompt": "x", "unsupported": true})
	require.Error(t, err)
	out, _, err := modelconfig.Resolve(doc, "model", "text_video", map[string]any{"prompt": "x", "optional_extension": true})
	require.NoError(t, err)
	require.NotContains(t, out, "optional_extension")
	_, _, err = modelconfig.Resolve(doc, "model", "text_video", map[string]any{"prompt": "x", "resolution": "4k"})
	require.Error(t, err)
	_, _, err = modelconfig.Resolve(doc, "model", "text_video", map[string]any{})
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "prompt"))
}

func TestConfiguredCapabilitySubsetCannotBypassPricesAndMappings(t *testing.T) {
	amount := 1.25
	document := modelconfig.Empty("yuxibox_media")
	document.Groups["g"] = modelconfig.Group{Name: "rich configured contract", Modes: map[string]modelconfig.Mode{"mixed_ref": {Enabled: true, Input: map[string]any{"marker": "configured"}, Mapping: map[string]string{"unsupported": "@reject"}, Cost: modelconfig.Cost{Amount: &amount}}}}
	document.Bindings["model"] = map[string]modelconfig.Binding{"mixed_ref": {GroupID: "g"}}
	actual, err := modelconfig.InferConfiguredMode(document, "model", "video_generate", map[string]any{"prompt": "only text"}, nil)
	require.NoError(t, err)
	require.Equal(t, "text_video", actual)
	input, definition, err := modelconfig.Resolve(document, "model", actual, map[string]any{"prompt": "only text"})
	require.NoError(t, err)
	require.Equal(t, "configured", input["marker"])
	require.Equal(t, &amount, definition.Cost.Amount)
	_, _, err = modelconfig.Resolve(document, "model", actual, map[string]any{"prompt": "only text", "unsupported": true})
	require.ErrorContains(t, err, "unsupported")
	_, _, err = modelconfig.Resolve(document, "model", "edit_image", map[string]any{"prompt": "x"})
	require.ErrorContains(t, err, "not enabled")
}
