package model

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestChannelModelConfigurationDatabaseMatrix(t *testing.T) {
	cases := []struct {
		name, dsn string
		dialector gorm.Dialector
		kind      common.DatabaseType
	}{}
	// External databases must be explicitly dedicated disposable instances.
	// No application DSN, environment file or running service credential is read.
	cases = append(cases, struct {
		name, dsn string
		dialector gorm.Dialector
		kind      common.DatabaseType
	}{"sqlite", ":memory:", sqlite.Open(":memory:"), common.DatabaseTypeSQLite})
	if dsn := os.Getenv("CHANNEL_CONFIG_TEST_MYSQL_DSN"); dsn != "" {
		require.Contains(t, dsn, "127.0.0.1:33177")
		require.Contains(t, dsn, "/six_config_test")
		cases = append(cases, struct {
			name, dsn string
			dialector gorm.Dialector
			kind      common.DatabaseType
		}{"mysql", dsn, mysql.Open(dsn), common.DatabaseTypeMySQL})
	}
	if dsn := os.Getenv("CHANNEL_CONFIG_TEST_POSTGRES_DSN"); dsn != "" {
		require.Contains(t, dsn, "port=54377")
		require.Contains(t, dsn, "dbname=six_config_test")
		cases = append(cases, struct {
			name, dsn string
			dialector gorm.Dialector
			kind      common.DatabaseType
		}{"postgres", dsn, postgres.Open(dsn), common.DatabaseTypePostgreSQL})
	}
	if os.Getenv("CHANNEL_CONFIG_TEST_REQUIRE_THREE") == "1" {
		require.Len(t, cases, 3, "all three actual database engines are required")
	}
	original := DB
	originalMain, originalLog := common.MainDatabaseType(), common.LogDatabaseType()
	t.Cleanup(func() { DB = original; common.SetDatabaseTypes(originalMain, originalLog) })
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var err error
			DB, err = gorm.Open(tc.dialector, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
			require.NoError(t, err)
			common.SetDatabaseTypes(tc.kind, common.DatabaseTypeSQLite)
			sqlDB, err := DB.DB()
			require.NoError(t, err)
			defer sqlDB.Close()
			require.NoError(t, DB.AutoMigrate(&Channel{}, &ChannelModelConfiguration{}, &Task{}))
			require.NoError(t, DB.AutoMigrate(&ChannelModelConfiguration{}))
			const target = 18100301
			const other = 18100302
			// These IDs belong only to the dedicated test database above.
			require.NoError(t, DB.Where("channel_id IN ?", []int{target, other}).Delete(&ChannelModelConfiguration{}).Error)
			require.NoError(t, DB.Where("id IN ?", []int{target, other}).Delete(&Channel{}).Error)
			require.NoError(t, DB.Create(&Channel{Id: target, Type: 61, Name: "matrix", Key: "isolated-only-target", Models: "existing", Status: 1}).Error)
			require.NoError(t, DB.Create(&Channel{Id: other, Type: 61, Name: "untouched", Key: "isolated-only-other", Models: "keep", Status: 2}).Error)
			defer DB.Where("channel_id IN ?", []int{target, other}).Delete(&ChannelModelConfiguration{})
			defer DB.Where("id IN ?", []int{target, other}).Delete(&Channel{})
			d := modelconfig.Empty("paisio_media")
			d.Groups["unicode"] = modelconfig.Group{Name: "模型参数与价格", Modes: map[string]modelconfig.Mode{"text_image": {Enabled: true, Input: map[string]any{"n": float64(1), "prompt": strings.Repeat("长文本", 10000)}}}}
			d.Bindings["image"] = map[string]modelconfig.Binding{"text_image": {GroupID: "unicode"}}
			first, err := SaveChannelModelConfiguration(context.Background(), target, 1, d, 0)
			require.NoError(t, err)
			require.Equal(t, int64(1), first.Revision)
			// The optional supplement must survive the same payload storage on all
			// three engines, including reopen and a second revision.
			manual := modelconfig.Empty("xcmapi_media")
			catalog, err := modelconfig.ProviderCatalog(manual.Provider)
			require.NoError(t, err)
			for id, raw := range catalog.(map[string]any)["interfaces"].(map[string]any) {
				entry := raw.(map[string]any)
				if !strings.Contains(entry["title"].(string), "QuickStart") {
					continue
				}
				protocol := &modelconfig.ProtocolBinding{TemplateModel: id, Confirmed: true, Supplement: map[string]modelconfig.CapabilitySupplement{"video_ref": {Note: "人工确认参考视频", Fields: map[string]modelconfig.SupplementField{"videos": {Vendor: "reference_videos", Shape: "urls", MaxItems: 2}}}}}
				contract, err := modelconfig.SupplementInterface(entry, protocol)
				require.NoError(t, err)
				parameters := map[string]modelconfig.Parameter{}
				for field, value := range contract["parameters"].(map[string]any) {
					var parameter modelconfig.Parameter
					data, err := common.Marshal(value)
					require.NoError(t, err)
					require.NoError(t, common.Unmarshal(data, &parameter))
					parameters[field] = parameter
				}
				manual.Groups["manual"] = modelconfig.Group{Modes: map[string]modelconfig.Mode{"video_ref": {Enabled: true, Input: map[string]any{}, Parameters: parameters}}}
				manual.Bindings["actual-model"] = map[string]modelconfig.Binding{"video_ref": {GroupID: "manual", Protocol: protocol}}
				break
			}
			require.NotEmpty(t, manual.Bindings)
			_, err = SaveChannelModelConfiguration(t.Context(), other, 1, manual, 0)
			require.NoError(t, err)
			reopened, err := GetChannelModelConfiguration(t.Context(), other, 0)
			require.NoError(t, err)
			require.Equal(t, manual.Bindings["actual-model"]["video_ref"].Protocol.Supplement, reopened.Bindings["actual-model"]["video_ref"].Protocol.Supplement)
			_, err = SaveChannelModelConfiguration(t.Context(), other, 1, reopened, 1)
			require.NoError(t, err)
			const taskID = "task_six_config_matrix_frozen"
			require.NoError(t, DB.Where("task_id = ?", taskID).Delete(&Task{}).Error)
			defer DB.Where("task_id = ?", taskID).Delete(&Task{})
			task := Task{TaskID: taskID, ChannelId: target, PrivateData: TaskPrivateData{Execution: &TaskExecutionSnapshot{ChannelModelConfigurationRevision: first.Revision, TaskPlugin: &TaskPluginSnapshot{Key: "paisio_media", Version: "old-pinned-version"}}}}

			amount, estimate := 1.25, 2.5
			task.PrivateData.BillingContext = &TaskBillingContext{TieredSnapshot: &billingexpr.BillingSnapshot{PricingTimestamp: 1792051200, ExprString: `u("seconds") * 0.05`, TaskUsageBilling: true}, UpstreamCost: &modelconfig.CostSnapshot{PricingTimestamp: 1792051200, Revision: first.Revision, Model: "image", Mode: "text_image", Cost: modelconfig.Cost{Amount: &amount, Currency: "CNY", Unit: "image", Confirmed: true}, Estimate: &estimate, Status: "estimated"}}
			require.NoError(t, DB.Create(&task).Error)

			_, err = SaveChannelModelConfiguration(context.Background(), target, 1, d, 0)
			require.ErrorIs(t, err, ErrModelConfigurationConflict)
			restored, err := GetChannelModelConfiguration(context.Background(), target, 1)
			require.NoError(t, err)
			require.Equal(t, first.Groups["unicode"].Modes["text_image"].Input["prompt"], restored.Groups["unicode"].Modes["text_image"].Input["prompt"])
			_, err = SaveChannelModelConfiguration(context.Background(), target, 1, restored, 1)
			require.NoError(t, err)
			versions, err := ListChannelModelConfigurationVersions(context.Background(), target)
			require.NoError(t, err)
			require.Len(t, versions, 2)
			var historical Task
			require.NoError(t, DB.Where("task_id = ?", taskID).First(&historical).Error)
			require.Equal(t, int64(1), historical.PrivateData.Execution.ChannelModelConfigurationRevision)
			require.Equal(t, "old-pinned-version", historical.PrivateData.Execution.TaskPlugin.Version)
			require.Equal(t, "CNY", historical.PrivateData.BillingContext.UpstreamCost.Cost.Currency)
			require.Equal(t, 1.25, *historical.PrivateData.BillingContext.UpstreamCost.Cost.Amount)
			require.Equal(t, 2.5, *historical.PrivateData.BillingContext.UpstreamCost.Estimate)
			require.Nil(t, historical.PrivateData.BillingContext.UpstreamCost.Actual)
			require.Equal(t, int64(1792051200), historical.PrivateData.BillingContext.TieredSnapshot.PricingTimestamp)

			var targetRow, otherRow Channel
			require.NoError(t, DB.First(&targetRow, target).Error)
			require.NoError(t, DB.First(&otherRow, other).Error)
			require.Equal(t, "isolated-only-target", targetRow.Key)
			require.Equal(t, "existing", targetRow.Models)
			require.Equal(t, "isolated-only-other", otherRow.Key)
			require.Equal(t, "keep", otherRow.Models)
			require.Equal(t, 2, otherRow.Status)
		})
	}
}
