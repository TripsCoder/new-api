package relay

import (
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestSnapshotlessReviewedProviderTaskNeverUsesCurrentPlugin(t *testing.T) {
	previous := jsplugin.DefaultRegistry
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	t.Cleanup(func() { jsplugin.DefaultRegistry = previous })
	source := `export const meta={apiVersion:1,key:"xcmapi_media",name:"Fixture",version:"2.0.0",author:{name:"test"},models:["m"],fetchMode:"per_task"};export function buildSubmitRequest(){return {url:"https://provider.invalid"}};export function parseSubmitResponse(){return {taskId:"fixture"}};export function buildQueryRequest(){throw new Error("must not use current source")};export function parseTaskResult(){return {status:"UNKNOWN"}};`
	_, err := jsplugin.DefaultRegistry.Register(source, jsplugin.Options{})
	require.NoError(t, err)
	task := &model.Task{Platform: constant.TaskPlatform("xcmapi_media")}
	require.NotNil(t, GetTaskAdaptor(task.Platform))
	require.Nil(t, GetTaskAdaptorForTask(task))
}
