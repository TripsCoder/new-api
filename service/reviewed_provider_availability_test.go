package service

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type availabilityRoundTrip func(*http.Request) (*http.Response, error)

func (fn availabilityRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}
func TestReviewedProviderAvailabilityRefreshesPreparingWithoutDisablingConfiguration(t *testing.T) {
	original := reviewedAvailabilityClient
	reviewedAvailabilityCache.Lock()
	reviewedAvailabilityCache.until = time.Time{}
	reviewedAvailabilityCache.Unlock()
	t.Cleanup(func() {
		reviewedAvailabilityClient = original
		reviewedAvailabilityCache.Lock()
		reviewedAvailabilityCache.until = time.Time{}
		reviewedAvailabilityCache.Unlock()
	})
	state := "preparing"
	calls := 0
	reviewedAvailabilityClient = &http.Client{Transport: availabilityRoundTrip(func(request *http.Request) (*http.Response, error) {
		calls++
		require.Equal(t, xcmAvailabilityURL, request.URL.String())
		require.Empty(t, request.Header.Get("Authorization"))
		raw, err := common.Marshal(map[string]any{"video_catalog": map[string]any{"updated_at": time.Now().Unix(), "models": []any{map[string]any{"model": "minimax-h3", "status": state, "groups": []any{map[string]any{"status": state, "accepting": state == "available"}}}}}})
		require.NoError(t, err)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	})}
	first := GetReviewedProviderAvailability(t.Context(), "xcmapi_media")
	require.Equal(t, "preparing", first.Models["minimax-h3"])
	first.Models["minimax-h3"] = "available"
	require.Equal(t, "preparing", GetReviewedProviderAvailability(t.Context(), "xcmapi_media").Models["minimax-h3"])
	require.Equal(t, 1, calls)
	state = "available"
	reviewedAvailabilityCache.Lock()
	reviewedAvailabilityCache.until = time.Time{}
	reviewedAvailabilityCache.Unlock()
	require.Equal(t, "available", GetReviewedProviderAvailability(t.Context(), "xcmapi_media").Models["minimax-h3"])
	require.Equal(t, 2, calls)
}
func TestReviewedProviderAvailabilityDoesNotTreatOldPublicationAsAvailable(t *testing.T) {
	original := reviewedAvailabilityClient
	reviewedAvailabilityCache.Lock()
	reviewedAvailabilityCache.until = time.Time{}
	reviewedAvailabilityCache.Unlock()
	t.Cleanup(func() {
		reviewedAvailabilityClient = original
		reviewedAvailabilityCache.Lock()
		reviewedAvailabilityCache.until = time.Time{}
		reviewedAvailabilityCache.Unlock()
	})
	raw, err := common.Marshal(map[string]any{"video_catalog": map[string]any{"updated_at": time.Now().Unix() - 601, "models": []any{map[string]any{"model": "minimax-h3", "status": "available", "accepting": true}}}})
	require.NoError(t, err)
	reviewedAvailabilityClient = &http.Client{Transport: availabilityRoundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	})}
	result := GetReviewedProviderAvailability(t.Context(), "xcmapi_media")
	require.Equal(t, "unknown", result.Status)
	require.Empty(t, result.Models)
}

func TestXCMAvailableRequiresExplicitOrderAcceptance(t *testing.T) {
	for _, tc := range []struct{ input, expected string }{
		{`{"status":"available","accepting":false}`, "unavailable"},
		{`{"status":"available"}`, "unknown"},
		{`{"status":"available","accepting":true}`, "available"},
		{`{"status":"available","groups":[{"status":"available","accepting":false}]}`, "unknown"},
		{`{"status":"available","groups":[{"status":"available","accepting":true}]}`, "available"},
		{`{"status":"available","accepting":false,"groups":[{"status":"available","accepting":true}]}`, "unavailable"},
		{`{"status":"preparing","accepting":true}`, "preparing"},
	} {
		var row xcmPublishedVideoModel
		require.NoError(t, common.Unmarshal([]byte(tc.input), &row))
		require.Equal(t, tc.expected, xcmVideoAcceptanceStatus(row))
	}
}
