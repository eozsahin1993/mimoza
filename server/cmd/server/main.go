// Command server is the "dedicated, always-on" alternative to cmd/lambda —
// the same handler from internal/app, served with http.ListenAndServe
// instead of through Lambda/API Gateway. Exists to prove the port/adapter
// split actually buys the portability it's meant to: nothing below
// internal/api changes to support this, only this file exists.
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"mimoza-relay/internal/app"
	blobstore "mimoza-relay/internal/blobs/s3"
	"mimoza-relay/internal/config"
)

func main() {
	cfg := config.Load()
	app.SetUpLogging(cfg.LogLevel)

	handler, err := app.New(context.Background(), cfg)
	if err != nil {
		log.Fatalf("failed to build the relay: %v", err)
	}

	addr := ":" + cfg.Port
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, logRequests(presignForRequestHost(cfg.AWSEndpointURL, handler))))
}

// presignForRequestHost signs S3 URLs for the host each request arrived on,
// whenever the relay reaches S3 on loopback — LocalStack. The relay dials
// localhost:4566, but a phone or emulator handed that URL dials itself.
// Whatever address the device used to reach this relay (a LAN IP, or
// 10.0.2.2 from the Android emulator) reaches this machine, and LocalStack
// listens on all interfaces, so the same host with LocalStack's port works
// from every device without configuring an address that DHCP can change.
func presignForRequestHost(endpoint string, next http.Handler) http.Handler {
	s3URL, err := url.Parse(endpoint)
	if err != nil || !isLoopback(s3URL.Hostname()) {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			// No port: an IPv6 literal keeps its brackets, which JoinHostPort
			// would add a second time.
			host = strings.TrimSuffix(strings.TrimPrefix(r.Host, "["), "]")
		}
		public := *s3URL
		public.Host = host
		if port := s3URL.Port(); port != "" {
			public.Host = net.JoinHostPort(host, port)
		}
		next.ServeHTTP(w, r.WithContext(blobstore.WithPresignEndpoint(r.Context(), public.String())))
	})
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// logRequests is local-dev-only — cmd/lambda gets this for free from
// API Gateway/CloudWatch.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}
