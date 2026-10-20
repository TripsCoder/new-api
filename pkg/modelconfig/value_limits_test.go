package modelconfig

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestUnrestrictedValueLimitsRetainTypesAndOldRules(t *testing.T) {
	var p Parameter
	require.NoError(t, common.Unmarshal([]byte(`{"minimum":4,"maximum":10,"enum":[5,"5",10,"10"],"definition":{"anyOf":[{"type":"integer","minimum":4,"maximum":10},{"type":"string","enum":["5","10"],"pattern":"^[0-9]+$"}],"x-business-allowed-values":"unlimited"}}`), &p))
	for _, value := range []any{float64(20), "20"} {
		require.NoError(t, validateParameter("seconds", value, p))
	}
	for _, value := range []any{true, "5s", float64(2.5)} {
		require.Error(t, validateParameter("seconds", value, p))
	}
	delete(p.Definition, "x-business-allowed-values")
	require.Error(t, validateParameter("seconds", float64(20), p))
	require.Error(t, validateParameter("seconds", "20", p))
	flag := true
	p.Required = &flag
	p.Definition["x-business-allowed-values"] = "unlimited"
	require.False(t, UnrestrictedValueLimits(p))
	require.Error(t, validateParameter("seconds", "20", p))
}

func TestUnrestrictedInterfaceValuesPreserveRequiredAndIsolatedOverrides(t *testing.T) {
	d := interfaceFixture(t)
	m := d.Groups["g"].Modes["text_video"]
	p := m.Parameters["seconds"]
	p.Definition["x-business-allowed-values"] = "unlimited"
	m.Parameters["seconds"] = p
	d.Groups["g"] = Group{Name: "shared", Modes: map[string]Mode{"text_video": m}}
	require.NoError(t, Validate(d))
	value, _, err := Resolve(d, "actual-fetched-ID", "text_video", map[string]any{"prompt": "fixture", "duration": float64(45)})
	require.NoError(t, err)
	require.Equal(t, float64(45), value["seconds"])
	_, _, err = Resolve(d, "actual-fetched-ID", "text_video", map[string]any{"duration": float64(45)})
	require.Error(t, err)
	other := d.Bindings["actual-fetched-ID"]["text_video"]
	p.Definition = map[string]any{"anyOf": []any{map[string]any{"type": "integer"}, map[string]any{"type": "string", "pattern": "^[0-9]+$"}}}
	p.Enum = []any{float64(5), "5"}
	other.Parameters = map[string]Parameter{"seconds": p}
	d.Bindings["other-ID"] = map[string]Binding{"text_video": other}
	_, _, err = Resolve(d, "other-ID", "text_video", map[string]any{"prompt": "fixture", "seconds": float64(45)})
	require.Error(t, err)
}
