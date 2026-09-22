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
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	awsssm "github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"mimoza-relay/internal/auth"
	authdynamodb "mimoza-relay/internal/auth/dynamodb"
	"mimoza-relay/internal/config"
	"mimoza-relay/internal/invite"
	invitedynamodb "mimoza-relay/internal/invite/dynamodb"
	"mimoza-relay/internal/push"
	pushdynamodb "mimoza-relay/internal/push/dynamodb"
	"mimoza-relay/internal/ratelimit"
	ratelimitdynamodb "mimoza-relay/internal/ratelimit/dynamodb"
	"mimoza-relay/internal/synclog"
	"mimoza-relay/internal/synclog/cdn"
	logdynamodb "mimoza-relay/internal/synclog/dynamodb"
	blobs3 "mimoza-relay/internal/synclog/s3"
	"mimoza-relay/internal/util/localstack"
)

// Resource names and schemas come from internal/util/localstack, which
// cmd/testrelay uses too — one definition, so a table this suite creates
// can't differ in shape from the one the relay is served against.
var (
	shared             = localstack.Shared()
	tableName          = shared.TableName
	bucketName         = shared.BucketName
	sessionsTableName  = shared.SessionsTableName
	inviteTableName    = shared.InviteTableName
	rateLimitTableName = shared.RateLimitTableName
	pushTableName      = shared.PushTableName
)

var (
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
	return fmt.Sprintf("account-%s-%d", t.Name(), time.Now().UnixNano())
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

// NewLogStore returns a real dynamodb-backed LogStore against LocalStack,
// creating the test table once per test binary run (shared across tests —
// safe because tests use distinct syncID values). Skips the test if
// LocalStack isn't reachable.
func NewLogStore(t testing.TB) synclog.LogStore {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	tableOnce.Do(func() {
		tableErr = localstack.CreateTable(context.Background(), client, tableName, localstack.WithSortKey)
		if tableErr == nil {
			tableErr = localstack.EnsureEntryIDIndex(context.Background(), client, tableName)
		}
	})
	if tableErr != nil {
		unreachable(t, "DynamoDB", tableErr)
	}

	return logdynamodb.New(client, tableName)
}

// RawDynamoDBClient returns the same client + table name NewLogStore uses,
// for tests that need to inspect raw item attributes (e.g. expiresAt) or
// delete an item directly to simulate what DynamoDB's background TTL
// sweep would eventually do — sweep timing itself isn't something a fast
// unit test can exercise for real.
func RawDynamoDBClient(t testing.TB) (*awsdynamodb.Client, string) {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	tableOnce.Do(func() {
		tableErr = localstack.CreateTable(context.Background(), client, tableName, localstack.WithSortKey)
		if tableErr == nil {
			tableErr = localstack.EnsureEntryIDIndex(context.Background(), client, tableName)
		}
	})
	if tableErr != nil {
		unreachable(t, "DynamoDB", tableErr)
	}

	return client, tableName
}

// NewBlobStore returns a real s3-backed BlobStore against LocalStack,
// creating the test bucket once per test binary run.
func NewBlobStore(t testing.TB) synclog.BlobStore {
	t.Helper()
	client := awss3.NewFromConfig(loadConfig(t), func(o *awss3.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
		o.UsePathStyle = true
	})

	bucketOnce.Do(func() { bucketErr = localstack.CreateBucket(context.Background(), client, bucketName) })
	if bucketErr != nil {
		unreachable(t, "S3", bucketErr)
	}

	return blobs3.New(client, bucketName, 0)
}

// NewBlobStoreWithCDN returns a blob store whose downloads are signed for
// CloudFront, with the settings and signing key put in LocalStack's SSM
// exactly as Terraform and the operator would.
//
// CloudFront itself isn't emulated, so this proves the parts that live
// here — that the relay finds its settings, parses the key, and hands out
// a signed CDN URL instead of an S3 one — not that CloudFront accepts the
// signature. That only shows up in staging.
func NewBlobStoreWithCDN(t testing.TB, prefix string) synclog.BlobStore {
	t.Helper()

	awsCfg := loadConfig(t)
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

	store := NewBlobStore(t).(*blobs3.Store)
	return store.WithDownloads(cdn.New(cdn.Config{
		SettingsParameter: "/" + prefix + "/cdn",
		KeyParameter:      "/" + prefix + "/cloudfront-signing-key",
	}, awsCfgWithEndpoint(awsCfg)))
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

// NewInviteStore returns a real dynamodb-backed invite.Store
// against LocalStack, creating the test table once per test binary run —
// composite pk/sk, same key shape as NewLogStore's table (see
// server/provision/modules/storage/dynamodb.tf's invites resource), a
// genuinely separate table from everything else. Takes a
// retentionDays param for the same reason NewLogStore does: tests that
// assert on the written expiresAt need a known, non-default window.
func NewInviteStore(t testing.TB, retentionDays int64) invite.Store {
	t.Helper()
	// 0 stands for "whatever production would use", as config resolves it.
	if retentionDays == 0 {
		retentionDays = config.DefaultInviteRetentionDays
	}
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	inviteTableOnce.Do(func() {
		inviteTableErr = localstack.CreateTable(context.Background(), client, inviteTableName, localstack.WithSortKey)
	})
	if inviteTableErr != nil {
		unreachable(t, "DynamoDB", inviteTableErr)
	}

	return invitedynamodb.New(client, inviteTableName, retentionDays)
}

// RawInviteDynamoDBClient returns the same client + table name
// NewInviteStore uses, for tests that need to inspect raw item
// attributes (e.g. expiresAt) — same purpose as RawDynamoDBClient, against
// the separate invites table.
func RawInviteDynamoDBClient(t testing.TB) (*awsdynamodb.Client, string) {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	inviteTableOnce.Do(func() {
		inviteTableErr = localstack.CreateTable(context.Background(), client, inviteTableName, localstack.WithSortKey)
	})
	if inviteTableErr != nil {
		unreachable(t, "DynamoDB", inviteTableErr)
	}

	return client, inviteTableName
}

// NewPushStore returns a real dynamodb-backed push.Store against
// LocalStack, creating the push table once per test binary run (see
// server/provision/modules/storage/push_table.tf).
func NewPushStore(t testing.TB) push.Store {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})

	pushTableOnce.Do(func() {
		pushTableErr = localstack.CreateTable(context.Background(), client, pushTableName, localstack.WithSortKey)
	})
	if pushTableErr != nil {
		unreachable(t, "DynamoDB", pushTableErr)
	}

	return pushdynamodb.New(client, pushTableName, config.DefaultInviteRetentionDays)
}

// NewPushStoreWithRetention is NewPushStore with a chosen invite retention
// — negative to write temporary rows that have already expired.
func NewPushStoreWithRetention(t testing.TB, retentionDays int64) push.Store {
	t.Helper()
	NewPushStore(t)
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})
	return pushdynamodb.New(client, pushTableName, retentionDays)
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

// UploadBlob puts payload at a presigned POST target, the way a client
// does. Fields must be written before the "file" part: S3 requires that
// order and ignores anything after it.
//
// Lives here rather than in one package's _test.go because two packages
// now need a blob that genuinely exists — one to read back the uploader
// recorded on it, one to delete it.
func UploadBlob(t testing.TB, target synclog.UploadTarget, payload []byte) {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range target.Fields {
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

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, target.URL, &body)
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
		t.Fatalf("upload failed: %d %s", resp.StatusCode, responseBody)
	}
}

// RawItem reads one item straight out of the log table, bypassing the
// store — for asserting on attributes the Store interface deliberately
// doesn't expose, like the TTL stamp a deleted circle's meta carries.
func RawItem(t testing.TB, pk, sk string) (map[string]ddbtypes.AttributeValue, error) {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})
	out, err := client.GetItem(context.Background(), &awsdynamodb.GetItemInput{
		TableName: aws.String(tableName),
		Key: map[string]ddbtypes.AttributeValue{
			"pk": &ddbtypes.AttributeValueMemberS{Value: pk},
			"sk": &ddbtypes.AttributeValueMemberS{Value: sk},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	return out.Item, nil
}

// RawPushItem is RawItem against the push table, for the expiresAt the
// push Store sets but never returns.
func RawPushItem(t testing.TB, pk, sk string) (map[string]ddbtypes.AttributeValue, error) {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstack.Endpoint())
	})
	out, err := client.GetItem(context.Background(), &awsdynamodb.GetItemInput{
		TableName: aws.String(pushTableName),
		Key: map[string]ddbtypes.AttributeValue{
			"pk": &ddbtypes.AttributeValueMemberS{Value: pk},
			"sk": &ddbtypes.AttributeValueMemberS{Value: sk},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	return out.Item, nil
}
