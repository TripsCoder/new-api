package service

import (
	"errors"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/gin-gonic/gin"
)

var (
	ErrInvalidRequestedChannelHeader = errors.New("invalid channel selection header")
	ErrRequestedTaskChannelMismatch  = errors.New("requested channel does not match task")
)

// ConsumeRequestedChannelHeader removes every spelling before plugins or
// providers can see it. Exactly one canonical positive decimal int is accepted.
// Reentry may confirm an existing selection, but cannot overwrite it. Absence
// preserves the structured context used by internal request runners.
func ConsumeRequestedChannelHeader(c *gin.Context) (present bool, err error) {
	if c == nil || c.Request == nil {
		return false, nil
	}
	var values []string
	spellings := 0
	for name, entries := range c.Request.Header {
		if strings.EqualFold(name, constant.ChannelSelectionHeader) {
			present = true
			spellings++
			values = append(values, entries...)
			delete(c.Request.Header, name)
		}
	}
	if !present {
		return false, nil
	}
	if spellings != 1 || len(values) != 1 {
		return true, ErrInvalidRequestedChannelHeader
	}
	id, parseErr := strconv.Atoi(values[0])
	if parseErr != nil || id <= 0 || strconv.Itoa(id) != values[0] {
		return true, ErrInvalidRequestedChannelHeader
	}
	constraints := GetChannelConstraints(c)
	if constraints.RequestedChannelID != 0 && constraints.RequestedChannelID != id {
		return true, ErrInvalidRequestedChannelHeader
	}
	constraints.RequestedChannelID = id
	return true, nil
}

// CheckRequestedTaskChannel only checks consistency for an already-authorized
// task. Callers must first enforce its owner or signed artifact grant. It does
// not authorize access, select a new channel, consult current channel status,
// or reapply submission model/group rules to historical results.
func CheckRequestedTaskChannel(c *gin.Context, channelID int) error {
	if _, err := ConsumeRequestedChannelHeader(c); err != nil {
		return err
	}
	requestedID := GetChannelConstraints(c).RequestedChannelID
	if requestedID > 0 && requestedID != channelID {
		return ErrRequestedTaskChannelMismatch
	}
	return nil
}

// RequestedTaskChannelErrorMessage localizes presentation without changing the
// sentinel errors used for task/channel consistency checks.
func RequestedTaskChannelErrorMessage(c *gin.Context, err error) string {
	switch {
	case errors.Is(err, ErrInvalidRequestedChannelHeader):
		return i18n.T(c, i18n.MsgRequestedChannelHeaderInvalid)
	case errors.Is(err, ErrRequestedTaskChannelMismatch):
		return i18n.T(c, i18n.MsgRequestedTaskChannelMismatch)
	default:
		return err.Error()
	}
}
