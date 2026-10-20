package service

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestXCMNativeH3VisibilityUsesOnlySelectedKeyAndExactModel(t *testing.T) {
	old := nativeXCMVisibilityClient
	t.Cleanup(func() { nativeXCMVisibilityClient = old })
	calls := 0
	body := `{"data":[{"id":"h3"}]}`
	status := 200
	nativeXCMVisibilityClient = &http.Client{Transport: availabilityRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		require.Equal(t, "GET", r.Method)
		require.Equal(t, "https://xcmapi.org/v1/models", r.URL.String())
		require.Equal(t, "Bearer fixture-selected-key", r.Header.Get("Authorization"))
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	require.True(t, XCMNativeH3Visible(t.Context(), "https://xcmapi.org/v1", "fixture-selected-key"))
	body = `{"data":[{"id":"minimax-h3"}]}`
	require.False(t, XCMNativeH3Visible(t.Context(), "https://xcmapi.org", "fixture-selected-key"))
	body = `{"success":false,"data":[{"id":"h3"}]}`
	require.False(t, XCMNativeH3Visible(t.Context(), "https://xcmapi.org", "fixture-selected-key"))
	status = 401
	require.False(t, XCMNativeH3Visible(t.Context(), "https://xcmapi.org", "fixture-selected-key"))
	status = 200
	body = strings.Repeat("x", (1<<20)+1)
	require.False(t, XCMNativeH3Visible(t.Context(), "https://xcmapi.org", "fixture-selected-key"))
	before := calls
	for _, base := range []string{"http://xcmapi.org", "https://xcmapi.org.evil.invalid", "https://user@xcmapi.org", "https://xcmapi.org?key=bad", "https://xcmapi.org:444", "https://xcmapi.org/custom"} {
		require.False(t, XCMNativeH3Visible(t.Context(), base, "fixture-selected-key"))
	}
	require.False(t, XCMNativeH3Visible(t.Context(), "https://xcmapi.org", ""))
	require.Equal(t, before, calls)
}

func TestXCMNativeH3VisibilityDoesNotForwardKeyOnRedirect(t *testing.T) {
	old := nativeXCMVisibilityClient
	t.Cleanup(func() { nativeXCMVisibilityClient = old })
	calls := 0
	client := *old
	client.Transport = availabilityRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://other.invalid/v1/models"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	nativeXCMVisibilityClient = &client
	require.False(t, XCMNativeH3Visible(t.Context(), "https://xcmapi.org", "fixture-selected-key"))
	require.Equal(t, 1, calls)
}

func TestXCMNativeH3VisibilityUsesSelectedTransportWithoutMutatingIt(t *testing.T) {
	calls := 0
	client := &http.Client{Timeout: 20 * time.Second, Transport: availabilityRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		require.Equal(t, "Bearer fixture-selected-key", r.Header.Get("Authorization"))
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"h3"}]}`))}, nil
	})}
	require.True(t, XCMNativeH3Visible(t.Context(), "https://xcmapi.org", "fixture-selected-key", client))
	require.Equal(t, 1, calls)
	require.Equal(t, 20*time.Second, client.Timeout)
	require.Nil(t, client.CheckRedirect)
}
