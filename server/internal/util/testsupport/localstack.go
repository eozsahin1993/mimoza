// Package testsupport wires the real adapters (not fakes) to a LocalStack
// instance at localhost:4566, so tests exercise actual DynamoDB, S3 and
// SSM wire behavior. Those three services are all LocalStack needs to run
// (see the workflow's SERVICES list) — CloudFront is Pro-only, so blob
// URL signing is exercised against the real signer with a locally
// generated key, and only invalidation goes untested until staging.
//
// Not a _test.go file — a regular package imported by other packages'
// tests, per Go convention for shared test helpers. Google/Apple
// sign-in verification isn't exercised against LocalStack at all — there's
// nothing to emulate (no AWS service involved), so internal/oidcverify's
// own tests use a locally-generated key pair instead.
package testsupport

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	awsssm "github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

	accountsdynamo "mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/auth"
	authdynamodb "mimoza-relay/internal/auth/dynamodb"
	"mimoza-relay/internal/blobs/cdn"
	blobstore "mimoza-relay/internal/blobs/s3"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/ratelimit"
	ratelimitdynamodb "mimoza-relay/internal/ratelimit/dynamodb"
	"mimoza-relay/internal/util/localstack"
)

// Resource names and schemas come from internal/util/localstack, which
// cmd/testrelay uses too — one definition, so a table this suite creates
// can't differ in shape from the one the relay is served against.
var (
	shared             = localstack.Shared()
	bucketName         = shared.BucketName
	sessionsTableName  = shared.SessionsTableName
	rateLimitTableName = shared.RateLimitTableName
)

var (
	accountsTableOnce sync.Once
	accountsTableErr  error

	circlesTableOnce sync.Once
	circlesTableErr  error

	tableOnce sync.Once
	tableErr  error

	bucketOnce sync.Once
	bucketErr  error

	sessionsTableOnce sync.Once
	sessionsTableErr  error

	inviteTableOnce sync.Once
	inviteTableErr  error

	pushTableOnce sync.Once
	pushTableErr  error

	rateLimitTableOnce sync.Once
	rateLimitTableErr  error
)

// UniqueSyncID returns a syncID guaranteed not to collide with data left
// behind by a previous test run — the shared test table isn't wiped
// between `go test` invocations, only created once, so hardcoded IDs
// (and hardcoded epoch assertions) would go flaky on a second run.
func UniqueSyncID(t testing.TB) string {
	t.Helper()
	return fmt.Sprintf("%s-%d", t.Name(), time.Now().UnixNano())
}

// UniqueEmail returns a fake-but-uniquely-formatted email address, for
// the same reason UniqueCircleID exists — the shared sessions/accounts
// tables aren't wiped between test runs.
func UniqueEmail(t testing.TB) string {
	t.Helper()
	return fmt.Sprintf("test-%d@example.com", time.Now().UnixNano())
}

// UniqueAccountID returns an opaque string standing in for a real account
// identifier (provider:sub) — for adapter-level tests that only care about
// key uniqueness, not about how a real one is derived.
func UniqueAccountID(t testing.TB) string {
	t.Helper()
	return "account-" + unique(t)
}

// UniqueInviteTag returns an opaque string standing in for hash(invite_code)
// — for adapter-level tests that only care about key uniqueness, not about
// how a real invite tag is derived.
// The counter, not just the clock: two calls in one statement can land on
// the same tick, and callers that need two distinct tags usually write them
// exactly that way.
var uniqueTagCounter atomic.Uint64

func UniqueInviteTag(t testing.TB) string {
	t.Helper()
	return fmt.Sprintf("invite-%s-%d-%d", t.Name(), time.Now().UnixNano(), uniqueTagCounter.Add(1))
}

// unreachable is what every store constructor here does when LocalStack
// isn't there — skip, or fail when the environment says a missing one is
// a broken pipeline rather than a missing tool. See localstack.Required.
func unreachable(t testing.TB, service string, err error) {
	t.Helper()
	if localstack.Required() {
		t.Fatalf("%s is set but LocalStack %s is unreachable: %v", localstack.RequireEnv, service, err)
	}
	t.Skipf("LocalStack %s not reachable, skipping: %v", service, err)
}

func loadConfig(t testing.TB) aws.Config {
	t.Helper()
	cfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "")),
	)
	if err != nil {
		t.Fatalf("failed to load AWS config: %v", err)
	}
	return cfg
}

// NewAccountTable returns the shared accounts table against LocalStack,
// for the slices that build their stores on it. Shared across tests —
// safe because each picks its own account.
func NewAccountTable(t testing.TB) *accountsdynamo.Table {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	accountsTableOnce.Do(func() {
		accountsTableErr = localstack.CreateTable(context.Background(), client, shared.AccountsTableName, localstack.WithSortKey)
	})
	if accountsTableErr != nil {
		unreachable(t, "DynamoDB", accountsTableErr)
	}

	return accountsdynamo.NewTable(client, shared.AccountsTableName)
}

// NewCircleTable returns the shared circles table against LocalStack,
// with its indexes, for the slices that build their stores on it. Shared
// across tests — safe because each picks its own circle id.
func NewCircleTable(t testing.TB) *dynamo.Table {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	circlesTableOnce.Do(func() {
		circlesTableErr = localstack.CreateTable(context.Background(), client, shared.CirclesTableName, localstack.WithSortKey)
		if circlesTableErr == nil {
			circlesTableErr = localstack.EnsureCircleIndexes(context.Background(), client, shared.CirclesTableName)
		}
	})
	if circlesTableErr != nil {
		unreachable(t, "DynamoDB", circlesTableErr)
	}

	return dynamo.NewTable(client, shared.CirclesTableName)
}

// UniqueCircleID keeps one test's circle out of every other test's way,
// the shared table being shared.
func UniqueCircleID(t testing.TB) string {
	t.Helper()
	return "circle-" + unique(t)
}

// unique is a test's name and a number that only ever goes up. The
// clock alone is not enough: UnixNano is microsecond-resolution on some
// machines, so two ids minted in the same breath come out identical, and
// two members with one id is a roster that reads short.
func unique(t testing.TB) string {
	t.Helper()
	return fmt.Sprintf("%s-%d-%d", t.Name(), time.Now().UnixNano(), uniqueCounter.Add(1))
}

var uniqueCounter atomic.Int64

// NewBlobBucket returns the circles column's blob storage against
// LocalStack, sharing the one test bucket.
func NewBlobBucket(t testing.TB) *blobstore.Store {
	t.Helper()
	return blobstore.New(blobClient(t), bucketName, 0)
}

// NewBlobBucketWithCDN is NewBlobBucket with downloads signed for
// CloudFront, with the settings and signing key put in LocalStack's SSM
// exactly as Terraform and an operator would.
//
// CloudFront itself is not emulated, so this proves the parts that live
// here — that the relay finds its settings, parses the key and hands out
// a signed CDN URL rather than an S3 one — not that CloudFront accepts
// the signature. That only shows up in staging.
func NewBlobBucketWithCDN(t testing.TB, prefix string) *blobstore.Store {
	t.Helper()
	awsCfg := loadConfig(t)
	putCDNParameters(t, awsCfg, prefix)
	return NewBlobBucket(t).WithDownloads(cdn.New(cdn.Config{
		SettingsParameter: "/" + prefix + "/cdn",
		KeyParameter:      "/" + prefix + "/cloudfront-signing-key",
	}, awsCfgWithEndpoint(awsCfg)))
}

// blobClient is the one S3 client both blob helpers share, creating the
// test bucket once per test binary run.
func blobClient(t testing.TB) *awss3.Client {
	t.Helper()
	client := awss3.NewFromConfig(loadConfig(t), func(o *awss3.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
		o.UsePathStyle = true
	})
	bucketOnce.Do(func() { bucketErr = localstack.CreateBucket(context.Background(), client, bucketName) })
	if bucketErr != nil {
		unreachable(t, "S3", bucketErr)
	}
	return client
}

// putCDNParameters writes what the signer reads at runtime: where the
// distribution is, and the key to sign with.
func putCDNParameters(t testing.TB, awsCfg aws.Config, prefix string) {
	t.Helper()
	ssmClient := awsssm.NewFromConfig(awsCfg, func(o *awsssm.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate signing key: %v", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	put := func(name, value, kind string) {
		if _, err := ssmClient.PutParameter(context.Background(), &awsssm.PutParameterInput{
			Name:      aws.String(name),
			Value:     aws.String(value),
			Type:      ssmtypes.ParameterType(kind),
			Overwrite: aws.Bool(true),
		}); err != nil {
			unreachable(t, "SSM", err)
		}
	}
	put("/"+prefix+"/cdn", `{"baseUrl":"https://cdn.example.com","keyPairId":"K123","distributionId":"E123"}`, "String")
	put("/"+prefix+"/cloudfront-signing-key", string(keyPEM), "SecureString")
}

// The signer builds its own clients from an aws.Config, so LocalStack has
// to be pointed at there rather than per-client.
func awsCfgWithEndpoint(cfg aws.Config) aws.Config {
	cfg.BaseEndpoint = aws.String(localstack.Endpoint())
	return cfg
}

// NewAuthStore returns a real dynamodb-backed AuthStore against LocalStack,
// creating the sessions table once per test binary run — same
// sync.Once-guarded create-if-not-exists pattern as NewLogStore, against a
// genuinely separate table from everything else (see
// server/provision/modules/storage/sessions_table.tf).
func NewAuthStore(t testing.TB) auth.Store {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	sessionsTableOnce.Do(func() {
		sessionsTableErr = localstack.CreateTable(context.Background(), client, sessionsTableName, localstack.HashOnly)
		if sessionsTableErr == nil {
			sessionsTableErr = localstack.EnsureAccountIDIndex(context.Background(), client, sessionsTableName)
		}
	})
	if sessionsTableErr != nil {
		unreachable(t, "DynamoDB", sessionsTableErr)
	}

	return authdynamodb.New(client, sessionsTableName)
}

// NewRateLimitStore returns a real dynamodb-backed ratelimit.Store
// against LocalStack, creating the rate-limit table once per test binary
// run (see server/provision/modules/storage/rate_limit_table.tf). Unlike the other New*
// helpers, callers pick their own keyPrefix/maxRequests/window per test —
// a Store instance is scoped to one particular budget.
func NewRateLimitStore(t testing.TB, keyPrefix string, maxRequests int, window time.Duration) ratelimit.Store {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	rateLimitTableOnce.Do(func() {
		rateLimitTableErr = localstack.CreateTable(context.Background(), client, rateLimitTableName, localstack.HashOnly)
	})
	if rateLimitTableErr != nil {
		unreachable(t, "DynamoDB", rateLimitTableErr)
	}

	return ratelimitdynamodb.New(client, rateLimitTableName, keyPrefix, maxRequests, window)
}

// PostBlob sends the bytes the way a device does: a multipart form to
// the presigned URL, with the signed fields alongside them, so S3 itself
// applies the policy the relay signed.
func PostBlob(t testing.TB, url string, fields map[string]string, payload []byte) {
	t.Helper()
	if status := TryPostBlob(t, url, fields, payload); status < 200 || status >= 300 {
		t.Fatalf("upload failed: %d", status)
	}
}

// TryPostBlob is PostBlob without the assertion, for the tests that mean
// to be refused: it answers with S3's status rather than failing.
func TryPostBlob(t testing.TB, url string, fields map[string]string, payload []byte) int {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("WriteField(%s): %v", key, err)
		}
	}
	part, err := writer.CreateFormFile("file", "blob")
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, url, &body)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST upload: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		responseBody, _ := io.ReadAll(resp.Body)
		t.Logf("upload refused: %d %s", resp.StatusCode, responseBody)
	}
	return resp.StatusCode
}
