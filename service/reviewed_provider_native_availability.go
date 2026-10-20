package service

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

// Native h3 is a separate published interface, outside video_catalog. Its
// contract requires visibility in the currently selected key's exact catalog.
// Never share visibility across keys, follow credential-bearing redirects, or
// infer h3 permission from minimax-h3 / a saved channel model name.
var nativeXCMVisibilityClient = &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func XCMNativeH3Visible(ctx context.Context, baseURL, key string, selectedClients ...*http.Client) bool {
	base, err := url.Parse(baseURL)
	if err != nil || base.Scheme != "https" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || (base.Host != "xcmapi.org" && base.Host != "www.xcmapi.org") || key == "" {
		return false
	}
	if path := strings.TrimRight(base.Path, "/"); path != "" && path != "/v1" {
		return false
	}
	base.Path = "/v1/models"
	base.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return false
	}
	request.Header.Set("Authorization", "Bearer "+key)
	client := *nativeXCMVisibilityClient
	if len(selectedClients) > 0 && selectedClients[0] != nil {
		client = *selectedClients[0]
	}
	client.Timeout = 3 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return false
	}
	var payload struct {
		Success *bool `json:"success"`
		Data    []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if common.Unmarshal(raw, &payload) != nil || (payload.Success != nil && !*payload.Success) {
		return false
	}
	for _, model := range payload.Data {
		if model.ID == "h3" {
			return true
		}
	}
	return false
}
