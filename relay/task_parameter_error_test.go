package relay

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSixProviderParameterHTTPErrorKeepsSupplierMessageAndStatus(t *testing.T) {
	service.InitHttpClient()
	saveBillingConfig(t)
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{"billing_setting.billing_mode": `{"declared-model":"tiered_expr"}`, "billing_setting.billing_expr": `{"declared-model":"tier(\"flat\", 3)"}`}))
	for _, provider := range []string{"paisio_media", "yuxibox_media", "xcmapi_media", "artbox_media", "lxmone_media", "zhangyuge_media"} {
		for _, status := range []int{http.StatusBadRequest, http.StatusUnprocessableEntity} {
			t.Run(provider+http.StatusText(status), func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(status)
					_, _ = w.Write([]byte(`{"error":{"message":"duration must be 5s","param":"duration"}}`))
				}))
				defer server.Close()
				source := `export const meta={apiVersion:1,key:"` + provider + `",name:"Error fixture",version:"2.1.1",author:{name:"Test"},models:["declared-model"],fetchMode:"per_task"};export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/submit",method:"POST",body:{model:ctx.model},action:"text_to_video"}};export function parseSubmitResponse(){throw new Error("must not parse unsuccessful HTTP")};export function buildQueryRequest(){return {url:"https://provider.invalid"}};export function parseTaskResult(){return {status:"UNKNOWN"}};`
				c, info := newTaskSubmitContext(t, "declared-model", "")
				common.SetContextKey(c, constant.ContextKeyChannelBaseUrl, server.URL)
				c.Set("group", "default")
				info.UserGroup = "default"
				info.UsingGroup = "default"
				info.OriginModelName = "declared-model"
				info.Billing = &imageReservation{limit: 1 << 30}
				pinMappingOrderPlugin(t, c, source)
				result, err := RelayTaskSubmit(c, info)
				require.Nil(t, result)
				require.NotNil(t, err)
				require.Equal(t, status, err.StatusCode)
				require.Equal(t, "fail_to_fetch_task", err.Code)
				require.Equal(t, "duration must be 5s", err.Message)
			})
		}
	}
}
