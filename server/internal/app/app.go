// Package app wires the real AWS adapters into api.Deps — the one place
// cmd/server and cmd/lambda both build the relay, so a wiring mistake in
// one can't go unnoticed in the other.
package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	"mimoza-relay/internal/api"
	"mimoza-relay/internal/auth/appleid"
	"mimoza-relay/internal/auth/oidcverify"
	"mimoza-relay/internal/config"
	"mimoza-relay/internal/push"
	"mimoza-relay/internal/push/apns"
	"mimoza-relay/internal/push/fcm"

	manifestdynamodb "mimoza-relay/internal/account/dynamodb"
	authdynamodb "mimoza-relay/internal/auth/dynamodb"
	invitedynamodb "mimoza-relay/internal/invite/dynamodb"
	pushdynamodb "mimoza-relay/internal/push/dynamodb"
	ratelimitdynamodb "mimoza-relay/internal/ratelimit/dynamodb"
	"mimoza-relay/internal/synclog/cdn"
	logdynamodb "mimoza-relay/internal/synclog/dynamodb"
	blobs3 "mimoza-relay/internal/synclog/s3"
)

const (
	googleIssuer  = "https://accounts.google.com"
	googleJWKSURL = "https://www.googleapis.com/oauth2/v3/certs"
	appleIssuer   = "https://appleid.apple.com"
	appleJWKSURL  = "https://appleid.apple.com/auth/keys"
)

// New returns the relay's handler, wired to real DynamoDB and S3 from the
// ambient AWS configuration. Returns an error rather than exiting, so a
// caller that isn't a `main` — a test, say — gets to decide.
// SetUpLogging installs the process-wide logger: JSON, because CloudWatch
// filters and metric filters read fields ({ $.reason = "..." }) and can
// only pattern-match a sentence.
//
// Called by the cmd/ entry points before anything else, so a failure while
// building the relay is logged the same way as everything after it.
func SetUpLogging(level string) {
	var parsed slog.Level
	if err := parsed.UnmarshalText([]byte(level)); err != nil {
		parsed = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parsed})))
}

func New(ctx context.Context, cfg config.Config) (*http.ServeMux, error) {
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	return api.NewRouter(Deps(cfg, awsCfg)), nil
}

// Deps builds the real AWS-backed dependencies, separate from New so a
// caller with its own aws.Config — LocalStack, say — gets this wiring
// rather than a copy of it. See cmd/testrelay, which also needs the
// stores directly to mint sessions.
func Deps(cfg config.Config, awsCfg aws.Config) api.Deps {
	dynamo := func() *awsdynamodb.Client { return awsdynamodb.NewFromConfig(awsCfg) }
	// Applied here, not per-binary: cmd/lambda never read this flag before,
	// silently ignoring it.
	s3Client := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) { o.UsePathStyle = cfg.S3ForcePathStyle })

	limit := func(kind string, max int64) *ratelimitdynamodb.Store {
		return ratelimitdynamodb.New(dynamo(), cfg.RateLimitTableName, kind, int(max), cfg.RateLimitWindow())
	}

	fcmDispatch := fcm.NewDispatcher(awsCfg, cfg.FCMCredentialParameter, cfg.FCMCredentialFile)
	apnsDispatch := apns.NewDispatcher(awsCfg, cfg.APNSAuthKeyParameter, cfg.APNSAuthKeyFile, cfg.APNSKeyID, cfg.APNSTeamID, cfg.APNSTopic, cfg.APNSProduction)

	// Whether downloads actually come from CloudFront is decided at
	// runtime by whether its settings parameter exists — see
	// internal/synclog/cdn. Nothing to configure per environment.
	blob := blobs3.New(s3Client, cfg.BucketName, cfg.MaxBlobSize).WithDownloads(cdn.New(cdn.Config{
		SettingsParameter: cfg.BlobCDNSettingsParameter,
		KeyParameter:      cfg.BlobCDNSigningKeyParameter,
	}, awsCfg))

	// Nil unless a Sign in with Apple key is configured — everything
	// downstream treats that as "revocation is off" (see appleid.NewClient).
	appleID := appleid.NewClient(awsCfg, cfg.AppleSignInKeyParameter, cfg.AppleSignInKeyFile, cfg.AppleSignInKeyID, cfg.AppleSignInTeamID, cfg.AppleClientIDIOS)
	// Said once at startup rather than per deletion: accepting Apple
	// sign-ins without being able to revoke their grants is what fails
	// App Store review (Guideline 5.1.1(v)), and the failure is otherwise
	// invisible until someone deletes an account and checks Settings.
	if appleID == nil && cfg.AppleClientIDIOS != "" {
		slog.Warn("Sign in with Apple accepted, but deleting an account can't revoke its grant",
			"reason", "apple_revocation_not_configured")
	}

	return api.Deps{
		Log:        logdynamodb.New(dynamo(), cfg.TableName),
		Blob:       blob,
		Auth:       authdynamodb.New(dynamo(), cfg.SessionsTableName),
		Manifest:   manifestdynamodb.New(dynamo(), cfg.AccountsOldTableName),
		Invite:     invitedynamodb.New(dynamo(), cfg.InviteTableName, cfg.InviteRetentionDays),
		WriteLimit: limit("write", cfg.RateLimitWriteMaxRequests),
		ReadLimit:  limit("read", cfg.RateLimitReadMaxRequests),
		Google:     oidcverify.New(googleIssuer, googleJWKSURL, nonEmpty(cfg.GoogleClientIDIOS, cfg.GoogleClientIDAndroid, cfg.GoogleClientIDWeb)),
		Apple:      oidcverify.New(appleIssuer, appleJWKSURL, nonEmpty(cfg.AppleClientIDIOS)),
		AppleID:    appleID,
		// Shares the accounts table rather than taking one of its own —
		// see auth/dynamodb's AppleCredentialStore for the key spacing.
		AppleCredentials: authdynamodb.NewAppleCredentialStore(dynamo(), cfg.AccountsOldTableName),
		Push: api.PushDeps{
			Store:          pushdynamodb.New(dynamo(), cfg.PushTableName, cfg.InviteRetentionDays),
			RecipientLimit: limit("push", cfg.RateLimitPushMaxRequests),
			// Each dispatcher gates on its own platform internally (see
			// fcm.NewDispatcher/apns.NewDispatcher), so calling both is a
			// no-op for whichever one a delivery isn't for.
			Dispatch: func(delivery push.Delivery, keyVersion int64, payload []byte) {
				fcmDispatch(delivery, keyVersion, payload)
				apnsDispatch(delivery, keyVersion, payload)
			},
		},
	}
}

// nonEmpty drops any not-yet-configured platform client ID (config.go
// leaves these as "" rather than requiring every platform up front) before
// they reach oidcverify.New's accepted-audience set.
func nonEmpty(values ...string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}
