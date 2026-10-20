package controller

import (
	"fmt"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgreSQLSixGatewayDiscoveryCompleteHandlerWithoutDeclaration(t *testing.T) {
	dsn := os.Getenv("CHANNEL_SCOPE_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL DSN not supplied")
	}
	require.Contains(t, dsn, "port=54377")
	require.Contains(t, dsn, "dbname=six_config_test")
	oldDB, oldRegistry := model.DB, jsplugin.DefaultRegistry
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent), NamingStrategy: schema.NamingStrategy{TablePrefix: fmt.Sprintf("dis%x_", time.Now().UnixNano())}})
	require.NoError(t, err)
	model.DB = db
	common.SetDatabaseTypes(common.DatabaseTypePostgreSQL, common.DatabaseTypeSQLite)
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	t.Cleanup(func() {
		require.NoError(t, db.Migrator().DropTable(&model.Channel{}))
		model.DB = oldDB
		jsplugin.DefaultRegistry = oldRegistry
		common.SetDatabaseTypes(oldMain, oldLog)
	})
	require.NoError(t, db.AutoMigrate(&model.Channel{}))
	source := `export const meta={apiVersion:1,key:"yuxibox_media",name:"fixture",version:"2.0.1",author:{name:"test"},models:["known"],fetchMode:"per_task"};export function buildSubmitRequest(){return {url:"https://provider.invalid/submit"}};export function parseSubmitResponse(){return {taskId:"x"}};export function buildQueryRequest(){return {url:"https://provider.invalid/query"}};export function parseTaskResult(){return {status:"UNKNOWN"}};`
	_, err = jsplugin.DefaultRegistry.Register(source, jsplugin.Options{})
	require.NoError(t, err)
	status := 200
	body := `{"data":[{"id":"KNOWN"},{"id":"future-live"}]}`
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "GET", r.Method)
		require.Equal(t, "/v1/models", r.URL.Path)
		require.Equal(t, "Bearer fixture-handler-secret", r.Header.Get("Authorization"))
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer upstream.Close()
	base := upstream.URL + "/v1/"
	setting := `{"task_plugin_key":"yuxibox_media"}`
	channel := model.Channel{Id: 611, Type: 61, Status: 1, Models: "known,kept-pending", Key: "fixture-handler-secret", BaseURL: &base, Setting: &setting}
	require.NoError(t, db.Create(&channel).Error)
	for _, declaration := range []string{"", `modelDiscovery:{path:"/v1/models",format:"openai",sourceStatus:"standard_unverified"},`, `modelDiscovery:{path:"/v1/models",format:"openai",sourceUrl:"https://docs.example/models",sourceSha256:"` + strings.Repeat("a", 64) + `",sourceStatus:"historical_declaration"},`} {
		jsplugin.DefaultRegistry = jsplugin.NewRegistry()
		_, err = jsplugin.DefaultRegistry.Register(strings.Replace(source, "apiVersion:1,", "apiVersion:1,"+declaration, 1), jsplugin.Options{})
		require.NoError(t, err)
		for _, test := range []struct {
			name    string
			status  int
			body    string
			success bool
			count   int
		}{{"real", 200, `{"data":[{"id":"KNOWN"},{"id":"future-live"}]}`, true, 2}, {"empty", 200, `{"data":[]}`, true, 0}, {"unauthorized", 401, `{"error":"fixture-handler-secret"}`, false, 0}, {"missing data", 200, `{"error":"fixture-handler-secret"}`, false, 0}} {
			t.Run(test.name, func(t *testing.T) {
				status = test.status
				body = test.body
				recorder := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(recorder)
				c.Params = gin.Params{{Key: "id", Value: "611"}}
				c.Set("id", 1)
				c.Request = httptest.NewRequest("GET", "/api/channel/611/fetch_models", nil)
				require.NotPanics(t, func() { FetchUpstreamModels(c) })
				var response struct {
					Success   bool           `json:"success"`
					Data      []string       `json:"data"`
					Discovery map[string]any `json:"discovery"`
				}
				require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
				require.Equal(t, test.success, response.Success)
				require.NotContains(t, recorder.Body.String(), "fixture-handler-secret")
				if test.success {
					require.Len(t, response.Data, test.count)
					expectedMethod := "standard_openai_probe"
					if declaration != "" {
						expectedMethod = "standard_unverified"
						if strings.Contains(declaration, "historical_declaration") {
							expectedMethod = "historical_declaration"
						}
					}
					require.Equal(t, expectedMethod, response.Discovery["discovery_method"])
					if !strings.Contains(declaration, "historical_declaration") {
						require.Empty(t, response.Discovery["source_sha256"])
					}
				}
				if test.status == 401 {
					require.Contains(t, recorder.Body.String(), "401")
				}
				var unchanged model.Channel
				require.NoError(t, db.First(&unchanged, 611).Error)
				require.Equal(t, channel.Models, unchanged.Models)
				require.Equal(t, channel.Key, unchanged.Key)
				require.Equal(t, channel.Status, unchanged.Status)
			})
		}
	}
	require.Equal(t, 12, calls)
	// The successful list is the upstream list, never the local model catalog.
	require.False(t, strings.Contains(body, "static"))
}
