package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"mimoza-relay/internal/util/localstack"
	"mimoza-relay/internal/util/testsupport"
)

func TestPresignForRequestHost(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	localStackHost := mustParse(t, localstack.Endpoint()).Host

	tests := []struct {
		name        string
		endpoint    string
		requestHost string
		wantHost    string
	}{
		{"phone on the LAN", "http://localhost:4566", "192.168.1.23:8090", "192.168.1.23:4566"},
		{"android emulator", "http://127.0.0.1:4566", "10.0.2.2:8090", "10.0.2.2:4566"},
		{"IPv6 host with port", "http://localhost:4566", "[fd00::1]:8090", "[fd00::1]:4566"},
		{"IPv6 host without port", "http://localhost:4566", "[fd00::1]", "[fd00::1]:4566"},
		{"no endpoint, as in AWS", "", "192.168.1.23:8090", localStackHost},
		{"non-loopback endpoint", "http://192.168.1.50:4566", "10.0.2.2:8090", localStackHost},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotHost string
			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				download, err := store.DownloadURL(r.Context(), "circle-1/post-1")
				if err != nil {
					t.Fatalf("DownloadURL: %v", err)
				}
				gotHost = mustParse(t, download).Host
			})

			req := httptest.NewRequest(http.MethodGet, "/v1/circles/circle-1/blobs/post-1", nil)
			req.Host = tt.requestHost
			presignForRequestHost(tt.endpoint, inner).ServeHTTP(httptest.NewRecorder(), req)

			if gotHost != tt.wantHost {
				t.Fatalf("presigned host = %s, want %s", gotHost, tt.wantHost)
			}
		})
	}
}

func mustParse(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return parsed
}
