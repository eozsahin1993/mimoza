// Package config is the one place environment-derived settings are read
// from. Add fields here rather than reaching for os.Getenv elsewhere.
package config

import (
	"log"
	"os"
	"strconv"
	"time"
)

// DefaultInviteRetentionDays matches the client's INVITE_TTL_MS (7 days).
// Eviction itself is DynamoDB's TTL; this only sets what expiresAt says.
const DefaultInviteRetentionDays = 7

// Resources names every table and the blob bucket one environment uses,
// derived from its prefix. A rename in provision/modules/storage must
// happen in ResourcesFor too.
type Resources struct {
	BucketName         string
	SessionsTableName  string
	AccountsTableName  string
	CirclesTableName   string
	RateLimitTableName string
}

// ResourcesFor derives every resource name from one prefix.
func ResourcesFor(prefix string) Resources {
	return Resources{
		BucketName:         prefix + "-blobs",
		SessionsTableName:  prefix + "-sessions",
		AccountsTableName:  prefix + "-accounts",
		CirclesTableName:   prefix + "-circles",
		RateLimitTableName: prefix + "-rate-limit",
	}
}

// Config is everything the relay reads from its environment. The push
// credential parameters are named from the same prefix as Resources.
type Config struct {
	Resources
	// FCMCredentialParameter is the SSM SecureString holding the FCM
	// service-account key. Hand-created — Terraform state is plaintext.
	FCMCredentialParameter string
	// FCMCredentialFile is a local path read instead of SSM, for
	// LocalStack. Empty in Lambda.
	FCMCredentialFile string
	// APNSAuthKeyParameter is the SSM SecureString holding the APNs .p8
	// auth key. Hand-created, like FCMCredentialParameter.
	APNSAuthKeyParameter string
	// APNSAuthKeyFile is a local path read instead of SSM — for LocalStack.
	APNSAuthKeyFile string
	// APNSKeyID/APNSTeamID identify the key at Apple. Unlike FCM's JSON
	// blob, the .p8 file carries neither, so they're configured separately.
	APNSKeyID  string
	APNSTeamID string
	// APNSTopic is the apns-topic header value — the app's iOS bundle id.
	APNSTopic string
	// APNSProduction selects api.push.apple.com over the sandbox host.
	// False by default: a debug-signed build only works against sandbox.
	APNSProduction bool
	// RateLimitWriteMaxRequests/RateLimitReadMaxRequests are starting
	// guesses, env-tunable so they can change without a redeploy.
	RateLimitWriteMaxRequests int64
	RateLimitReadMaxRequests  int64
	// RateLimitWindowMinutes is the fixed window both budgets reset on.
	RateLimitWindowMinutes int64
	// GoogleClientIDIOS/Android/Web are the accepted "aud" values for
	// Google Sign-In, one per platform so a missing one is an empty field
	// rather than a wrong slot in a combined list. May be empty if unused.
	GoogleClientIDIOS     string
	GoogleClientIDAndroid string
	GoogleClientIDWeb     string
	// AppleClientIDIOS is the accepted "aud" for Sign in with Apple
	// tokens, and the "sub" of the client secret internal/auth/appleid signs.
	AppleClientIDIOS string
	// AppleSignInKeyParameter is the SSM SecureString holding the Sign in
	// with Apple .p8 key. Hand-created like FCMCredentialParameter, and
	// not interchangeable with the APNs key above despite both being .p8s.
	AppleSignInKeyParameter string
	// AppleSignInKeyFile is a local path read instead of SSM — for LocalStack.
	AppleSignInKeyFile string
	// AppleSignInKeyID/AppleSignInTeamID identify that key at Apple, kept
	// separate from APNSTeamID's team so either can be set alone. Either
	// empty means revocation is off: deletion still works, minus the grant.
	AppleSignInKeyID  string
	AppleSignInTeamID string
	// BlobCDNSettingsParameter holds the blob CDN's base URL, key pair id
	// and distribution id as JSON. Written by modules/cdn, not here, to
	// avoid a dependency cycle with the Lambda's URL. Absent (local, or
	// before an env's first CDN apply) means "keep presigning S3".
	BlobCDNSettingsParameter string
	// BlobCDNSigningKeyParameter is the SSM SecureString holding the RSA
	// key that signs download URLs. Hand-created, like FCMCredentialParameter.
	BlobCDNSigningKeyParameter string
	// MaxBlobSize is passed to blobs/s3.New, overriding DefaultMaxBlobSize.
	// 0 means "use the adapter's own default" — see MAX_BLOB_SIZE_BYTES.
	MaxBlobSize int64
	// InviteRetentionDays is how long invites, join requests and push's
	// invite addresses last — one number for all three.
	InviteRetentionDays int64
	// LogLevel is debug|info|warn|error — info in deployed environments,
	// debug locally where the volume costs nothing and the detail helps.
	LogLevel string
	// Port is only used by cmd/server (cmd/lambda doesn't listen on a port).
	Port string
	// S3ForcePathStyle is true only for LocalStack, which can't resolve
	// virtual-hosted-style bucket subdomains. Never set true in a deployed env.
	S3ForcePathStyle bool
	// AWSEndpointURL mirrors the SDK's own AWS_ENDPOINT_URL (which the SDK
	// reads directly) for cmd/server's own presignForRequestHost. Empty in AWS.
	AWSEndpointURL string
}

// Load reads every setting from the environment once, at startup, and
// fails fast (log.Fatalf) on anything missing or malformed.
func Load() Config {
	prefix := mustEnv("RESOURCE_PREFIX")
	return Config{
		Resources:                  ResourcesFor(prefix),
		FCMCredentialParameter:     "/" + prefix + "/fcm-service-account",
		FCMCredentialFile:          os.Getenv("FCM_CREDENTIAL_FILE"),
		APNSAuthKeyParameter:       "/" + prefix + "/apns-auth-key",
		APNSAuthKeyFile:            os.Getenv("APNS_AUTH_KEY_FILE"),
		APNSKeyID:                  envOr("APNS_KEY_ID", ""),
		APNSTeamID:                 envOr("APNS_TEAM_ID", ""),
		APNSTopic:                  envOr("APNS_TOPIC", ""),
		APNSProduction:             envOr("APNS_PRODUCTION", "false") == "true",
		RateLimitWriteMaxRequests:  intEnv("RATE_LIMIT_WRITE_MAX_REQUESTS", 500),
		RateLimitReadMaxRequests:   intEnv("RATE_LIMIT_READ_MAX_REQUESTS", 2000),
		RateLimitWindowMinutes:     intEnv("RATE_LIMIT_WINDOW_MINUTES", 10),
		GoogleClientIDIOS:          envOr("GOOGLE_CLIENT_ID_IOS", ""),
		GoogleClientIDAndroid:      envOr("GOOGLE_CLIENT_ID_ANDROID", ""),
		GoogleClientIDWeb:          envOr("GOOGLE_CLIENT_ID_WEB", ""),
		AppleClientIDIOS:           envOr("APPLE_CLIENT_ID_IOS", ""),
		AppleSignInKeyParameter:    "/" + prefix + "/apple-signin-key",
		AppleSignInKeyFile:         os.Getenv("APPLE_SIGNIN_KEY_FILE"),
		AppleSignInKeyID:           envOr("APPLE_SIGNIN_KEY_ID", ""),
		AppleSignInTeamID:          envOr("APPLE_SIGNIN_TEAM_ID", ""),
		BlobCDNSettingsParameter:   "/" + prefix + "/cdn",
		BlobCDNSigningKeyParameter: "/" + prefix + "/cloudfront-signing-key",
		MaxBlobSize:                intEnv("MAX_BLOB_SIZE_BYTES", 0),
		InviteRetentionDays:        positiveIntEnv("INVITE_RETENTION_DAYS", DefaultInviteRetentionDays),
		LogLevel:                   envOr("LOG_LEVEL", "info"),
		Port:                       envOr("PORT", "8080"),
		S3ForcePathStyle:           envOr("S3_FORCE_PATH_STYLE", "false") == "true",
		AWSEndpointURL:             os.Getenv("AWS_ENDPOINT_URL"),
	}
}

// RateLimitWindow is RateLimitWindowMinutes as a time.Duration, for
// passing straight into ratelimitdynamodb.New.
func (c Config) RateLimitWindow() time.Duration {
	return time.Duration(c.RateLimitWindowMinutes) * time.Minute
}

func mustEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("missing required environment variable %s", name)
	}
	return value
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// positiveIntEnv is intEnv where zero or less is never meant: a
// retention of 0 would write expiry times already in the past.
func positiveIntEnv(name string, fallback int64) int64 {
	value := intEnv(name, fallback)
	if value <= 0 {
		log.Fatalf("%s must be positive, got %d", name, value)
	}
	return value
}

func intEnv(name string, fallback int64) int64 {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		log.Fatalf("%s must be an integer, got %q", name, raw)
	}
	return value
}
