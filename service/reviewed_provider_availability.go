package service

import (
	"context"
	"github.com/QuantumNous/new-api/common"
	"io"
	"maps"
	"net/http"
	"sync"
	"time"
)

type xcmPublishedVideoModel struct {
	Model     string `json:"model"`
	Status    string `json:"status"`
	Accepting *bool  `json:"accepting"`
	Groups    []struct {
		Status    string `json:"status"`
		Accepting *bool  `json:"accepting"`
	} `json:"groups"`
}

// An enabled model is not evidence that the public group accepts orders.
func xcmVideoAcceptanceStatus(row xcmPublishedVideoModel) string {
	switch row.Status {
	case "preparing", "maintenance", "unavailable":
		return row.Status
	case "available":
	default:
		return "unknown"
	}
	if row.Accepting != nil && !*row.Accepting {
		return "unavailable"
	}
	if len(row.Groups) > 0 {
		for _, group := range row.Groups {
			if group.Status == "available" && group.Accepting != nil && *group.Accepting {
				return "available"
			}
		}
		return "unknown"
	}
	if row.Accepting != nil && *row.Accepting {
		return "available"
	}
	return "unknown"
}

const xcmAvailabilityURL = "https://xcmapi.org/api/public/prices"

type ReviewedProviderAvailability struct {
	Provider  string            `json:"provider"`
	SourceURL string            `json:"sourceURL"`
	FetchedAt int64             `json:"fetchedAt"`
	UpdatedAt int64             `json:"updatedAt"`
	Status    string            `json:"status"`
	Models    map[string]string `json:"models"`
}

var reviewedAvailabilityClient = &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(r *http.Request, _ []*http.Request) error {
	if r.URL.Scheme != "https" || (r.URL.Hostname() != "www.xcmapi.org" && r.URL.Hostname() != "xcmapi.org") {
		return http.ErrUseLastResponse
	}
	return nil
}}
var reviewedAvailabilityCache struct {
	sync.Mutex
	value ReviewedProviderAvailability
	until time.Time
}

// GetReviewedProviderAvailability reads a bounded, credential-free public
// publication. A configuration's enabled flag never substitutes for this state.
// Short caching lets a daily opening become usable without editing config.
func GetReviewedProviderAvailability(ctx context.Context, key string) ReviewedProviderAvailability {
	unknown := ReviewedProviderAvailability{Provider: key, Status: "unknown", Models: map[string]string{}}
	if key != "xcmapi_media" {
		return unknown
	}
	unknown.SourceURL = xcmAvailabilityURL
	reviewedAvailabilityCache.Lock()
	defer reviewedAvailabilityCache.Unlock()
	now := time.Now()
	if now.Before(reviewedAvailabilityCache.until) {
		value := reviewedAvailabilityCache.value
		value.Models = maps.Clone(value.Models)
		return value
	}
	unknown.FetchedAt = now.Unix()
	reviewedAvailabilityCache.value = unknown
	reviewedAvailabilityCache.until = now.Add(5 * time.Second)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, xcmAvailabilityURL, nil)
	if err != nil {
		return unknown
	}
	response, err := reviewedAvailabilityClient.Do(request)
	if err != nil {
		return unknown
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return unknown
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return unknown
	}
	var payload struct {
		VideoCatalog struct {
			UpdatedAt float64                  `json:"updated_at"`
			Models    []xcmPublishedVideoModel `json:"models"`
		} `json:"video_catalog"`
	}
	if common.Unmarshal(raw, &payload) != nil {
		return unknown
	}
	updated := int64(payload.VideoCatalog.UpdatedAt)
	if updated <= 0 || updated > now.Unix()+60 || now.Unix()-updated > 600 {
		return unknown
	}
	result := unknown
	result.UpdatedAt = updated
	result.Status = "published"
	result.Models = map[string]string{}
	for _, row := range payload.VideoCatalog.Models {
		status := xcmVideoAcceptanceStatus(row)
		if row.Model != "" && len(row.Model) <= 256 {
			result.Models[row.Model] = status
		}
	}
	if len(result.Models) == 0 {
		return unknown
	}
	reviewedAvailabilityCache.value = result
	reviewedAvailabilityCache.until = now.Add(30 * time.Second)
	result.Models = maps.Clone(result.Models)
	return result
}
