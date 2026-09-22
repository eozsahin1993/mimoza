// Command testrelay serves the real relay (internal/app's wiring, not a
// copy) against LocalStack, for tests that drive it over HTTP — the
// integration suite, and later the app's headless UI-test peer. Never
// deployed: provision/modules/lambda/lambda.tf deploys cmd/lambda, not this.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	"mimoza-relay/internal/accounts"
	accountsdynamo "mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/api"
	"mimoza-relay/internal/app"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/localstack"
)

// sessionTTL only has to outlast a test run.
const sessionTTL = time.Hour

func main() {
	ctx := context.Background()

	awsCfg, err := localstack.Config(ctx)
	if err != nil {
		log.Fatalf("failed to configure AWS for LocalStack: %v", err)
	}

	// Idempotent, so restarting this between runs is free and CI needs no
	// separate provisioning step.
	s3Client := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) { o.UsePathStyle = true })
	if err := localstack.Provision(ctx, awsdynamodb.NewFromConfig(awsCfg), s3Client); err != nil {
		log.Fatalf("failed to provision LocalStack: %v", err)
	}

	// Shared() rather than Unique(): this process lives for the run, not
	// one test, so there's nothing to isolate it from — and its tables are
	// the ones internal/util/testsupport already expects to find.
	deps := app.Deps(localstack.RelayConfig(localstack.Shared()), awsCfg)
	mux := api.NewRouter(deps)
	registerTestOnly(mux, deps.Auth, deps.Accounts)

	address := addr()
	log.Printf("testrelay listening on %s against LocalStack at %s", address, localstack.Endpoint())
	log.Fatal(http.ListenAndServe(address, logRequests(mux)))
}

// Not 8090: that's the port the app's dev relay uses, and a test run
// quietly talking to a hand-started relay — or refusing to bind because
// one is already there — is worse than an explicit choice.
func port() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "8099"
}

// addr binds loopback by default. /testonly/session mints a session for
// any accountId a caller sends, with no auth of its own — fine on
// loopback, where "any caller" means this machine, but not once this
// starts listening on every interface. TESTRELAY_LISTEN_ALL opts in
// explicitly, for the one case that needs it: an Android emulator, which
// reaches the host over its own virtual network, not loopback.
func addr() string {
	host := "127.0.0.1"
	if os.Getenv("TESTRELAY_LISTEN_ALL") != "" {
		host = ""
	}
	return host + ":" + port()
}

// registerTestOnly mounts the one route that doesn't exist in a real
// relay: a session for an account, without a Google or Apple ID token.
//
// A bypass rather than a fake issuer because the alternative is worse —
// standing up a fake OIDC provider here would mean the integration suite
// testing the fake's JWKS round-trip rather than the relay. Real provider
// verification is covered where it belongs, by internal/api's own tests
// against testsupport.FakeOIDCProvider.
func registerTestOnly(mux *http.ServeMux, sessions auth.Store, accountStore *accountsdynamo.Table) {
	mux.HandleFunc("POST /testonly/session", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			// Subject stands in for what a provider would have verified.
			// The account id comes back from the accounts column, the
			// same way a real sign-in gets one.
			Subject string `json:"subject"`
			Token   string `json:"token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Subject == "" || body.Token == "" {
			http.Error(w, `{"error":"subject and token are both required"}`, http.StatusBadRequest)
			return
		}

		accountID, _, err := accountStore.Resolve(r.Context(), accounts.Provider{Name: "testonly", Subject: body.Subject})
		if err != nil {
			http.Error(w, `{"error":"could not resolve the account"}`, http.StatusInternalServerError)
			return
		}

		session := auth.Session{AccountID: accountID, ExpiresAt: time.Now().Add(sessionTTL)}
		if err := sessions.SaveSession(r.Context(), body.Token, session); err != nil {
			http.Error(w, `{"error":"could not save the session"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"accountId": accountID})
	})
}

// logRequests makes a failing integration test readable from the relay's
// side without attaching a debugger to it.
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
