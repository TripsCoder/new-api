package controller

import (
	"errors"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

func TestModelConfigurationInputErrorsIdentifyModelAndField(t *testing.T) {
	for _, item := range []struct{ text, field string }{
		{"unmapped unsupported parameter resolution", "resolution"},
		{"required parameter prompt", "prompt"},
		{"invalid value for parameter seconds", "seconds"},
		{"hook buildSubmitRequest: invalid_request: duration is outside the documented range", "duration"},
		{"invalid_request: images must be an array", "images"},
		{"model/mixed_ref/prompt: required document rules must be retained", "prompt"},
		{"selected protocol template does not implement this generation mode", "protocol"},
		{"request inputs are not enabled for this configured model", "capabilities"},
	} {
		t.Run(item.field+item.text, func(t *testing.T) {
			var message *common.Message
			require.ErrorAs(t, modelConfigurationInputError("sd2.5-9-2-480p", errors.New(item.text)), &message)
			require.Equal(t, "sd2.5-9-2-480p", message.Params["model"])
			require.Equal(t, item.field, message.Params["field"])
		})
	}
}
