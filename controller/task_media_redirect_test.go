package controller

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	relaychannel "github.com/QuantumNous/new-api/relay/channel"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskMediaRedirectRecoversSameSavedTaskAfterCDNFailure(t *testing.T) {
	task := setupGenericTaskTest(t)
	allowPrivateTaskMediaTest(t)
	var downloads, contentRequests int
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloads++
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Empty(t, r.Header.Get("Authorization"))
		assert.Empty(t, r.Header.Get("X-Api-Key"))
		assert.Equal(t, "bytes=0-3", r.Header.Get("Range"))
		if downloads == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 0-3/4")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("mp4!"))
	}))
	defer cdn.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentRequests++
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Equal(t, "/original/content", r.URL.Path)
		assert.Equal(t, "Bearer provider-secret", r.Header.Get("Authorization"))
		http.Redirect(w, r, cdn.URL+"/video.mp4", http.StatusFound)
	}))
	defer provider.Close()
	// This is the descriptor returned by the retained 2.1.5 content hook.
	descriptor := &relaychannel.TaskContentRequest{URL: provider.URL + "/original/content", Method: http.MethodGet, Headers: map[string]string{"Authorization": "Bearer provider-secret"}}
	for attempt := 0; attempt < 2; attempt++ {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodGet, "/content", nil)
		c.Request.Header.Set("Range", "bytes=0-3")
		err := proxyTaskMedia(c, task, descriptor)
		if attempt == 0 {
			require.Error(t, err)
		} else {
			require.NoError(t, err)
			assert.Equal(t, http.StatusPartialContent, recorder.Code)
			assert.Equal(t, "mp4!", recorder.Body.String())
		}
	}
	assert.Equal(t, 2, contentRequests)
	assert.Equal(t, 2, downloads)
	assert.Equal(t, "SUCCESS", string(task.Status))
}

func TestTaskMediaRedirectDropsAllProviderHeadersAndBody(t *testing.T) {
	allowPrivateTaskMediaTest(t)
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3000/content", nil)
	client := taskMediaRedirectClient(&http.Client{Jar: jar}, "", c, map[string]string{"Range": "bytes=0-3"})
	require.Nil(t, client.Jar)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			previous, err := http.NewRequest(method, "https://127.0.0.1:4000/content", nil)
			require.NoError(t, err)
			next, err := http.NewRequest(method, "https://127.0.0.1:5000/video.mp4", strings.NewReader("private-body"))
			require.NoError(t, err)
			for _, name := range []string{"Authorization", "Cookie", "X-Api-Key", "X-Signature", "Referer", "Origin"} {
				next.Header.Set(name, "private")
			}
			require.NoError(t, client.CheckRedirect(next, []*http.Request{previous}))
			assert.Equal(t, http.Header{"Range": {"bytes=0-3"}}, next.Header)
			assert.Equal(t, int64(0), next.ContentLength)
			assert.Nil(t, next.GetBody)
			body, err := io.ReadAll(next.Body)
			require.NoError(t, err)
			assert.Empty(t, body)
		})
	}
}

func TestTaskMediaRedirectRetainsSafetyChecks(t *testing.T) {
	allowPrivateTaskMediaTest(t)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3000/v1/tasks/original/artifacts/video/content", nil)
	client := taskMediaRedirectClient(http.DefaultClient, "", c, nil)
	for _, tc := range []struct{ name, from, to, originalMethod string }{
		{"downgrade", "https://127.0.0.1/a", "http://127.0.0.1/b", http.MethodGet},
		{"post-to-get", "http://127.0.0.1:4000/a", "http://127.0.0.1:5000/b", http.MethodPost},
		{"proxy-loop", "http://127.0.0.1:4000/a", "http://127.0.0.1:3000/v1/tasks/original/artifacts/video/content", http.MethodGet},
		{"userinfo", "http://127.0.0.1:4000/a", "http://user:secret@127.0.0.1:5000/b", http.MethodGet},
	} {
		t.Run(tc.name, func(t *testing.T) {
			from, err := http.NewRequest(tc.originalMethod, tc.from, nil)
			require.NoError(t, err)
			next, err := http.NewRequest(http.MethodGet, tc.to, nil)
			require.NoError(t, err)
			assert.ErrorIs(t, client.CheckRedirect(next, []*http.Request{from}), errTaskMediaRequestRejected)
		})
	}
	system_setting.GetFetchSetting().AllowPrivateIp = false
	from, _ := http.NewRequest(http.MethodGet, "http://127.0.0.2:4000/a", nil)
	next, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:5000/b", nil)
	assert.ErrorIs(t, client.CheckRedirect(next, []*http.Request{from}), errTaskMediaRequestRejected)
}
