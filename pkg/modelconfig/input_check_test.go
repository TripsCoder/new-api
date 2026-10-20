package modelconfig

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

func TestInputCheckIsolatesCurrentModelAndPreservesConfirmation(t *testing.T) {
	document := interfaceFixture(t)
	binding := document.Bindings["actual-fetched-ID"]["text_video"]
	binding.Protocol.Confirmed = false
	document.Bindings["other-ID"] = map[string]Binding{"text_image": {GroupID: "g", Protocol: &ProtocolBinding{TemplateModel: "invalid-other-interface"}}}
	group := document.Groups["g"]
	group.Modes["text_image"] = Mode{Enabled: true, Protocol: &ProtocolBinding{TemplateModel: "invalid-other-interface"}}
	document.Groups["g"] = group
	document.Groups["unrelated-invalid-group"] = Group{Name: "unrelated", Modes: map[string]Mode{"bad": {}}}
	before, err := common.Marshal(document)
	require.NoError(t, err)
	scoped, err := InputCheckDocument(document, "actual-fetched-ID")
	require.NoError(t, err)
	require.Len(t, scoped.Bindings, 1)
	require.Len(t, scoped.Groups, 1)
	require.Len(t, scoped.Groups["g"].Modes, 1)
	require.False(t, scoped.Bindings["actual-fetched-ID"]["text_video"].Protocol.Confirmed)
	after, err := common.Marshal(document)
	require.NoError(t, err)
	require.JSONEq(t, string(before), string(after))
	require.Error(t, Validate(document))
	require.ErrorContains(t, Validate(scoped), "confirm protocol applicability")
	require.Nil(t, ManualProtocolFor(scoped, "actual-fetched-ID", "text_video"))
	_, err = InputCheckDocument(document, "not-selected")
	require.ErrorContains(t, err, "no configuration")
}

func TestInputCheckRetainsCurrentModelRulesAndAllItsModes(t *testing.T) {
	document := interfaceFixture(t)
	binding := document.Bindings["actual-fetched-ID"]["text_video"]
	group := document.Groups["g"]
	definition := group.Modes["text_video"]
	definition.Protocol = binding.Protocol
	definition.Protocol.Confirmed = false
	group.Modes["text_video"] = definition
	group.Modes["image_video"] = definition
	document.Groups["g"] = group
	binding.Protocol = nil
	document.Bindings["actual-fetched-ID"]["text_video"] = binding
	document.Bindings["actual-fetched-ID"]["image_video"] = binding
	scoped, err := InputCheckDocument(document, "actual-fetched-ID")
	require.NoError(t, err)
	require.Len(t, scoped.Bindings["actual-fetched-ID"], 2)
	require.Len(t, scoped.Groups["g"].Modes, 2)
	_, _, err = Resolve(scoped, "actual-fetched-ID", "text_video", map[string]any{"duration": float64(6)})
	require.ErrorContains(t, err, "required parameter prompt")
	definition.Mapping["prompt"] = "@ignore"
	_, err = InputCheckDocument(document, "actual-fetched-ID")
	require.ErrorContains(t, err, "required document rules")
}
