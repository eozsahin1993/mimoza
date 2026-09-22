// Package config is the one place environment-derived settings are read
// from — both cmd/lambda and cmd/server call Load() instead of scattering
// (and duplicating) os.Getenv calls across entry points. Add new fields
// here as the app needs more configuration, rather than reaching for
// os.Getenv anywhere else.
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

// Every table, the blob bucket and both push-credential parameters are
// named from one RESOURCE_PREFIX (mimoza-<env>), under the same
// "<prefix>-<suffix>" convention server/provision/modules/storage and
// modules/lambda create them with. A rename on either side has to happen
// on both — nothing checks the two against each other.
type Config struct {
	TableName  string
	BucketName string
	// SessionsTableName is the standalone bearer-token session table — see
	// server/provision/modules/storage/sessions_table.tf. Not circle-scoped, so it's a
	// separate table from TableName; also separate from AccountsTableName
	// (token-lookup vs account-lookup are different access patterns).
	SessionsTableName string
	// AccountsTableName is one partition per account — profile, devices,
	// linked sign-in providers — see
	// server/provision/modules/storage/accounts_table.tf.
	AccountsTableName string
	// AccountsOldTableName is the pre-rewrite single-key accounts table
	// (the encrypted recovery manifest and the Apple refresh token), kept
	// under a new name until nothing reads it — see accounts_old_table.tf.
	AccountsOldTableName string
	// CirclesTableName is one partition per circle: membership, sealed
	// keys, invites, posts, activity — see circles_table.tf.
	CirclesTableName string
	// InviteTableName is the standalone invite/join-request table: pk =
	// hash(invite code), with one row for the invite itself and one row
	// per pending join request under it — see
	// server/provision/modules/storage/dynamodb.tf's invites resource.
	InviteTableName string
	// RateLimitTableName is the standalone per-account request-budget
	// table — see server/provision/modules/storage/rate_limit_table.tf. Shared by the write
	// and read budgets below; ratelimitdynamodb.New's keyPrefix keeps their
	// rows from colliding.
	RateLimitTableName string
	// PushTableName is the standalone push routing table — routing id
	// prefs plus one row per device. Separate from every other table for
	// the same reason the others are: different lifecycle, different
	// access pattern, and nothing joins across them.
	PushTableName string
	// FCMCredentialParameter is the SSM SecureString holding the FCM
	// service-account key. Created by hand, never by Terraform — a
	// Terraform-managed value lands in state as plaintext.
	FCMCredentialParameter string
	// FCMCredentialFile is a local path read instead of SSM — for running
	// the relay against LocalStack. Empty in Lambda.
	FCMCredentialFile string
	// APNSAuthKeyParameter is the SSM SecureString holding the APNs .p8
	// auth key. Same reasoning as FCMCredentialParameter: created by hand,
	// never by Terraform.
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
	// guesses, not measurements — env-tunable so they can be adjusted from
	// real traffic without a redeploy.
	RateLimitWriteMaxRequests int64
	RateLimitReadMaxRequests  int64
	// RateLimitPushMaxRequests budgets how many pushes one recipient
	// routing id may receive per window. Generous on purpose: a lively
	// circle legitimately generates a lot of received notifications, so
	// this bounds the pathological case rather than the merely noisy one.
	RateLimitPushMaxRequests int64
	// RateLimitWindowMinutes is the fixed window both budgets reset on.
	RateLimitWindowMinutes int64
	// GoogleClientIDIOS/Android/Web are the accepted "aud" values for
	// Google Sign-In ID tokens, one per platform client registered in
	// Google Cloud Console — named per-platform (mirroring app/.env.local's
	// EXPO_PUBLIC_GOOGLE_*_CLIENT_ID) rather than one combined list, so a
	// missing platform is an obviously-empty field instead of a silently
	// wrong position in a comma list. Any of these may be empty if that
	// platform isn't in use yet.
	GoogleClientIDIOS     string
	GoogleClientIDAndroid string
	GoogleClientIDWeb     string
	// AppleClientIDIOS is the accepted "aud" value for Sign in with Apple
	// ID tokens — the app's iOS bundle ID. A Services ID would join this
	// as a second named field if a web/Android Apple flow is ever added.
	// Also the "sub" of the client secret internal/auth/appleid signs.
	AppleClientIDIOS string
	// AppleSignInKeyParameter is the SSM SecureString holding the Sign in
	// with Apple .p8 key — the one account deletion revokes an Apple grant
	// with. Same reasoning as FCMCredentialParameter: created by hand,
	// never by Terraform. A different key from the APNs one above; the
	// developer portal issues them separately and they aren't
	// interchangeable.
	AppleSignInKeyParameter string
	// AppleSignInKeyFile is a local path read instead of SSM — for LocalStack.
	AppleSignInKeyFile string
	// AppleSignInKeyID identifies that key at Apple. AppleSignInTeamID is
	// the same team APNS_TEAM_ID names, kept a separate setting so one can
	// be configured without the other. Either empty means revocation is
	// off: deleting an account still works, it just leaves the Apple grant.
	AppleSignInKeyID  string
	AppleSignInTeamID string
	// BlobCDNSettingsParameter holds where the blob CDN is — base URL, key
	// pair id, distribution id — as JSON. Written by modules/cdn rather
	// than set here: the distribution needs the Lambda's function URL, so
	// telling the Lambda about the distribution in its own environment
	// would close a dependency cycle. Absent until blobs move to
	// CloudFront, which the relay reads as "keep presigning S3".
	BlobCDNSettingsParameter string
	// BlobCDNSigningKeyParameter is the SSM SecureString holding the RSA
	// private key that signs download URLs. Created by hand, never by
	// Terraform — same reasoning as FCMCredentialParameter.
	BlobCDNSigningKeyParameter string
	// MaxBlobSize is passed straight to s3.NewBlobStore, overriding its
	// DefaultMaxBlobSize — see .env.example's MAX_BLOB_SIZE_BYTES. 0 means
	// "use the adapter's own default".
	MaxBlobSize int64
	// InviteRetentionDays is how long invites, join requests and push's
	// invite addresses last — one number for all three, so none outlives
	// the others. See .env.example's INVITE_RETENTION_DAYS.
	// Eviction itself is DynamoDB's native TTL
	// (see provision/modules/storage/dynamodb.tf), not this process — this
	// only controls what expiresAt gets written as.
	InviteRetentionDays int64
	// LogLevel is debug|info|warn|error — info in deployed environments,
	// debug locally where the volume costs nothing and the detail helps.
	LogLevel string
	// Port is only used by cmd/server (cmd/lambda doesn't listen on a port).
	Port string
	// S3ForcePathStyle is only ever true for local testing against
	// LocalStack, which doesn't resolve virtual-hosted-style bucket
	// subdomains (bucket.host) the way real S3 does. Real AWS always uses
	// the default (false) — never set this in a deployed environment.
	S3ForcePathStyle bool
	// AWSEndpointURL is the SDK's own AWS_ENDPOINT_URL — the SDK reads it
	// directly; this copy is only for cmd/server to tell it's pointed at a
	// LocalStack on loopback (see its presignForRequestHost). Empty in AWS.
	AWSEndpointURL string
}

// Load reads every setting from the environment, once, at startup. Fails
// fast (log.Fatalf) on a missing required value or a malformed one —
// cmd/ entries are meant to crash immediately on misconfiguration, not
// limp along with a zero value.
func Load() Config {
	prefix := mustEnv("RESOURCE_PREFIX")
	return Config{
		TableName:                  prefix + "-sync-log",
		BucketName:                 prefix + "-blobs",
		SessionsTableName:          prefix + "-sessions",
		AccountsTableName:          prefix + "-accounts",
		AccountsOldTableName:       prefix + "-accounts-old",
		CirclesTableName:           prefix + "-circles",
		InviteTableName:            prefix + "-invites",
		RateLimitTableName:         prefix + "-rate-limit",
		PushTableName:              prefix + "-push",
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
		RateLimitPushMaxRequests:   intEnv("RATE_LIMIT_PUSH_MAX_REQUESTS", 500),
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

// positiveIntEnv is intEnv for a value where zero or less is never
// meant: a retention of 0 would write expiry times that have already
// passed.
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
