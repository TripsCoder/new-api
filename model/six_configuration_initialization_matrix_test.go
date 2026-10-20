package model

import (
	"fmt"
	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
	"os"
	"strings"
	"testing"
	"time"
)

func TestSixConfigurationInitializationExternalDatabaseMatrix(t *testing.T) {
	cases := []struct {
		name   string
		kind   common.DatabaseType
		driver gorm.Dialector
	}{}
	if dsn := os.Getenv("CHANNEL_CONFIG_TEST_MYSQL_DSN"); dsn != "" {
		require.True(t, strings.Contains(dsn, "127.0.0.1:33177") && strings.Contains(dsn, "/six_config_test"))
		cases = append(cases, struct {
			name   string
			kind   common.DatabaseType
			driver gorm.Dialector
		}{"mysql", common.DatabaseTypeMySQL, mysql.Open(dsn)})
	}
	if dsn := os.Getenv("CHANNEL_CONFIG_TEST_POSTGRES_DSN"); dsn != "" {
		require.True(t, strings.Contains(dsn, "port=54377") && strings.Contains(dsn, "dbname=six_config_test"))
		cases = append(cases, struct {
			name   string
			kind   common.DatabaseType
			driver gorm.Dialector
		}{"postgres", common.DatabaseTypePostgreSQL, postgres.Open(dsn)})
	}
	if os.Getenv("CHANNEL_CONFIG_TEST_REQUIRE_THREE") == "1" {
		require.Len(t, cases, 2)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			previous := DB
			oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
			db, err := gorm.Open(tc.driver, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent), NamingStrategy: schema.NamingStrategy{TablePrefix: fmt.Sprintf("si%x_", uint32(time.Now().UnixNano()))}})
			require.NoError(t, err)
			DB = db
			common.SetDatabaseTypes(tc.kind, common.DatabaseTypeSQLite)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			t.Cleanup(func() {
				require.NoError(t, db.Migrator().DropTable(&Task{}, &SixConfigurationInitializationRun{}, &ChannelModelConfiguration{}, &TaskPlugin{}, &Channel{}))
				_ = sqlDB.Close()
				DB = previous
				common.SetDatabaseTypes(oldMain, oldLog)
			})
			runSixConfigurationInitializationRehearsal(t)
		})
	}
}
