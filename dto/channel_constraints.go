package dto

type ChannelPinSource string

const (
	PinSourceToken      ChannelPinSource = "token"       // Rank 0, highest
	PinSourceOriginTask ChannelPinSource = "origin_task" // Rank 10
)

const (
	PinRankToken      = 0
	PinRankOriginTask = 10
)

type PinRetryMode int

const (
	PinRetrySameChannel PinRetryMode = iota
	PinRetrySingleAttempt
)

func (m PinRetryMode) Stricter(other PinRetryMode) PinRetryMode {
	if m == PinRetrySingleAttempt || other == PinRetrySingleAttempt {
		return PinRetrySingleAttempt
	}
	return PinRetrySameChannel
}

type ChannelPin struct {
	ChannelId int
	Source    ChannelPinSource
	Rank      int
	RetryMode PinRetryMode
}

type ChannelFilterKind string

const (
	FilterRequestPath        ChannelFilterKind = "request_path"
	FilterTaskPluginIdentity ChannelFilterKind = "task_plugin_identity"
	FilterResponsesWebSocket ChannelFilterKind = "responses_websocket"
)

type ChannelFilter struct {
	Kind                   ChannelFilterKind
	RequestPath            string
	TaskPluginKey          string
	TaskPluginKeys         []string
	TaskPluginChannelTypes []int
}

type ChannelConstraints struct {
	Pins    []ChannelPin
	Filters []ChannelFilter
	// RequestedChannelID is an explicit client selection, not an administrator
	// pin. It must pass the token's ordinary model and group authorization.
	RequestedChannelID int
	// RequestedChannelGroup freezes the first authorized billing group so later
	// decoder/distributor checks cannot silently change the route or its price.
	RequestedChannelGroup string
}

func (cc *ChannelConstraints) AddPin(p ChannelPin) {
	if cc == nil {
		return
	}
	cc.Pins = append(cc.Pins, p)
}

func (cc *ChannelConstraints) AddFilter(f ChannelFilter) {
	if cc == nil {
		return
	}
	cc.Filters = append(cc.Filters, f)
}

// ResolvedPin returns the winning pin after priority resolution.
// Lowest Rank wins. Pins that name the same channel are merged (stricter RetryMode).
// overridden lists pins that lost to a different channel (for warn logging).
func (cc *ChannelConstraints) ResolvedPin() (ChannelPin, bool, []ChannelPin) {
	if cc == nil || len(cc.Pins) == 0 {
		return ChannelPin{}, false, nil
	}

	merged := make(map[int]ChannelPin, len(cc.Pins))
	order := make([]int, 0, len(cc.Pins))
	for _, pin := range cc.Pins {
		existing, seen := merged[pin.ChannelId]
		if !seen {
			merged[pin.ChannelId] = pin
			order = append(order, pin.ChannelId)
			continue
		}
		existing.RetryMode = existing.RetryMode.Stricter(pin.RetryMode)
		if pin.Rank < existing.Rank {
			existing.Rank = pin.Rank
			existing.Source = pin.Source
		}
		merged[pin.ChannelId] = existing
	}

	winner := merged[order[0]]
	for _, channelID := range order[1:] {
		candidate := merged[channelID]
		if candidate.Rank < winner.Rank {
			winner = candidate
		}
	}

	var overridden []ChannelPin
	for _, channelID := range order {
		candidate := merged[channelID]
		if candidate.ChannelId != winner.ChannelId {
			overridden = append(overridden, candidate)
		}
	}
	return winner, true, overridden
}

func (cc *ChannelConstraints) SuppressesRetry() bool {
	// Explicit client selections get one attempt. Retrying an async submission
	// can create duplicate tasks even when the retry stays on the same channel.
	if cc != nil && cc.RequestedChannelID > 0 {
		return true
	}
	pin, found, _ := cc.ResolvedPin()
	return found && pin.RetryMode == PinRetrySingleAttempt
}
