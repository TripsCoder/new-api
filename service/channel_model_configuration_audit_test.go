package service

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"testing"
)

func TestChannelModelConfigurationRevisionIsPrivateAndFrozen(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/videos", nil)
	c.Set(modelconfig.ContextKeyRevision, int64(3))
	snapshot := TaskExecutionSnapshotFromContext(c)
	require.Equal(t, int64(3), snapshot.ChannelModelConfigurationRevision)
	c.Set(modelconfig.ContextKeyRevision, int64(8))
	require.Equal(t, int64(3), snapshot.ChannelModelConfigurationRevision)
	task := model.Task{PrivateData: model.TaskPrivateData{Execution: snapshot}}
	raw, err := common.Marshal(task)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "channel_model_configuration_revision")
	private, err := task.PrivateData.Value()
	require.NoError(t, err)
	var restored model.TaskPrivateData
	require.NoError(t, restored.Scan(private))
	require.Equal(t, int64(3), restored.Execution.ChannelModelConfigurationRevision)
}

func TestFailedUpstreamEstimateRemainsPendingInPrivateErrorAudit(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/videos", nil)
	c.Set(modelconfig.ContextKeyRevision, int64(4))
	amount, estimate := 2.0, 10.0
	cost := &modelconfig.CostSnapshot{Cost: modelconfig.Cost{Amount: &amount, Currency: "CNY", Unit: "second", Confirmed: true}, Estimate: &estimate, Status: "estimated"}
	c.Set(modelconfig.ContextKeyUpstreamCost, cost)
	before := model.NewLogOther()
	AppendTaskPluginContextAuditInfo(c, before)
	require.NotContains(t, before.JSONString(), "upstream_cost")
	c.Set(modelconfig.ContextKeyUpstreamAttempted, true)
	after := model.NewLogOther()
	AppendTaskPluginContextAuditInfo(c, after)
	var audit map[string]any
	require.NoError(t, common.Unmarshal([]byte(after.JSONString()), &audit))
	require.NotContains(t, audit, "upstream_cost")
	root := audit["root_info"].(map[string]any)
	pending := root["upstream_cost"].(map[string]any)
	require.Equal(t, "pending_bill_verification", pending["status"])
	require.Nil(t, pending["actual"])
	require.Equal(t, 10.0, pending["estimate"])
	require.Equal(t, "estimated", cost.Status)
	require.Nil(t, cost.Actual)
}
