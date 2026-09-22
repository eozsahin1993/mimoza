// Package localstack names the AWS resources a local LocalStack instance
// holds, and creates them — shared by internal/util/testsupport and
// cmd/testrelay so neither can drift onto a table shape the other isn't
// actually using.
package localstack

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	authdynamodb "mimoza-relay/internal/auth/dynamodb"
	circlesdynamodb "mimoza-relay/internal/circles/dynamodb"
	"mimoza-relay/internal/config"
	logdynamodb "mimoza-relay/internal/synclog/dynamodb"
)

// DefaultEndpoint is where LocalStack listens locally and in CI.
// EndpointEnv overrides it — including to a dead port, which is how
// Required's fail-rather-than-skip path gets tested without stopping a
// real container.
const (
	DefaultEndpoint = "http://localhost:4566"
	EndpointEnv     = "LOCALSTACK_ENDPOINT"
)

// Endpoint is where to find LocalStack. A function rather than a constant
// so every client in the module resolves it the same way — testsupport
// used to hold its own copy, which meant an override reached the
// integration suite and not the rest.
func Endpoint() string {
	if override := os.Getenv(EndpointEnv); override != "" {
		return override
	}
	return DefaultEndpoint
}

// Shared is the fixed set, named with the "test" prefix.
// internal/util/testsupport uses it for the whole Go suite at once, which
// is safe because those tests pick distinct ids and every table is
// partitioned by one.
func Shared() config.Resources {
	return config.ResourcesFor("test")
}

// Unique is a set nothing else will touch, for a test that wants an empty
// relay rather than a corner of a shared one — so it can assert on totals
// ("the log holds exactly these entries") instead of filtering to its own
// ids, and so a leak between tests is impossible rather than unlikely.
// Creating one costs about 200ms. The suffix must suit S3 bucket names:
// lowercase, digits and hyphens.
func Unique(suffix string) config.Resources {
	return config.ResourcesFor("bb-" + suffix)
}

// RequireEnv, when set, makes an unreachable LocalStack a failure instead
// of a skip.
const RequireEnv = "REQUIRE_LOCALSTACK"

// Required reports whether a missing LocalStack should fail rather than
// skip — set by CI, where a dead container should turn the run red
// instead of quietly skipping almost everything.
func Required() bool {
	return os.Getenv(RequireEnv) != ""
}

// Config points the SDK at LocalStack with throwaway credentials.
// BaseEndpoint lives on the config, not per client, so app.Deps can be
// handed this config and build ordinary clients with no LocalStack
// knowledge of its own.
func Config(ctx context.Context) (aws.Config, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "")),
	)
	if err != nil {
		return aws.Config{}, fmt.Errorf("load AWS config: %w", err)
	}
	cfg.BaseEndpoint = aws.String(Endpoint())
	return cfg, nil
}

// RelayConfig is config.Load's shape for a relay served against
// LocalStack, with test values baked in rather than read from the
// environment. Rate limits stay at their production defaults on
// purpose — unlike the Go suite, which pins them to a million to stay out
// of its own way, so this is the only place the real budgets and the
// router run together.
func RelayConfig(names config.Resources) config.Config {
	return config.Config{
		Resources:                 names,
		RateLimitWriteMaxRequests: 500,
		RateLimitReadMaxRequests:  2000,
		RateLimitPushMaxRequests:  500,
		RateLimitWindowMinutes:    10,
		// LocalStack doesn't resolve virtual-hosted-style bucket
		// subdomains, so presigned URLs have to be path style.
		S3ForcePathStyle: true,
	}
}

// Sorted is whether a table needs a range key as well as a hash key. By
// role rather than by name, since Unique renames everything.
type Sorted bool

const (
	HashOnly    Sorted = false
	WithSortKey Sorted = true
)

// tables pairs each table in a set with the schema its adapter expects.
func tables(n config.Resources) []struct {
	name   string
	sorted Sorted
} {
	return []struct {
		name   string
		sorted Sorted
	}{
		{n.TableName, WithSortKey},
		{n.InviteTableName, WithSortKey},
		{n.PushTableName, WithSortKey},
		{n.AccountsTableName, WithSortKey},
		{n.CirclesTableName, WithSortKey},
		{n.SessionsTableName, HashOnly},
		{n.RateLimitTableName, HashOnly},
	}
}

// Provision creates the shared set — see Shared.
func Provision(ctx context.Context, ddb *awsdynamodb.Client, s3 *awss3.Client) error {
	return ProvisionSet(ctx, ddb, s3, Shared())
}

// ProvisionSet creates every table and the bucket in one set. Idempotent,
// so a second run — another test package, another CI step, a restarted
// testrelay — is a no-op rather than a failure.
func ProvisionSet(ctx context.Context, ddb *awsdynamodb.Client, s3 *awss3.Client, names config.Resources) error {
	for _, table := range tables(names) {
		if err := CreateTable(ctx, ddb, table.name, table.sorted); err != nil {
			return fmt.Errorf("create %s: %w", table.name, err)
		}
	}
	if err := EnsureEntryIDIndex(ctx, ddb, names.TableName); err != nil {
		return fmt.Errorf("add entryId index to %s: %w", names.TableName, err)
	}
	if err := EnsureAccountIDIndex(ctx, ddb, names.SessionsTableName); err != nil {
		return fmt.Errorf("add accountId index to %s: %w", names.SessionsTableName, err)
	}
	if err := EnsureCircleIndexes(ctx, ddb, names.CirclesTableName); err != nil {
		return fmt.Errorf("add indexes to %s: %w", names.CirclesTableName, err)
	}
	if err := CreateBucket(ctx, s3, names.BucketName); err != nil {
		return fmt.Errorf("create %s: %w", names.BucketName, err)
	}
	return nil
}

// TeardownSet removes a set. Best effort — an already-gone resource isn't
// an error — and empties the bucket first, since S3 refuses to delete one
// that still holds objects.
func TeardownSet(ctx context.Context, ddb *awsdynamodb.Client, s3 *awss3.Client, names config.Resources) {
	for _, table := range tables(names) {
		_, _ = ddb.DeleteTable(ctx, &awsdynamodb.DeleteTableInput{TableName: aws.String(table.name)})
	}

	objects, err := s3.ListObjectsV2(ctx, &awss3.ListObjectsV2Input{Bucket: aws.String(names.BucketName)})
	if err == nil {
		for _, object := range objects.Contents {
			_, _ = s3.DeleteObject(ctx, &awss3.DeleteObjectInput{Bucket: aws.String(names.BucketName), Key: object.Key})
		}
	}
	_, _ = s3.DeleteBucket(ctx, &awss3.DeleteBucketInput{Bucket: aws.String(names.BucketName)})
}

// CreateTable creates one table, waiting for it to become active. An
// already-existing table is success — see ProvisionSet.
func CreateTable(ctx context.Context, client *awsdynamodb.Client, name string, sorted Sorted) error {
	keys := []ddbtypes.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: ddbtypes.KeyTypeHash}}
	attrs := []ddbtypes.AttributeDefinition{{AttributeName: aws.String("pk"), AttributeType: ddbtypes.ScalarAttributeTypeS}}
	if sorted {
		keys = append(keys, ddbtypes.KeySchemaElement{AttributeName: aws.String("sk"), KeyType: ddbtypes.KeyTypeRange})
		attrs = append(attrs, ddbtypes.AttributeDefinition{AttributeName: aws.String("sk"), AttributeType: ddbtypes.ScalarAttributeTypeS})
	}

	_, err := client.CreateTable(ctx, &awsdynamodb.CreateTableInput{
		TableName:            aws.String(name),
		BillingMode:          ddbtypes.BillingModePayPerRequest,
		KeySchema:            keys,
		AttributeDefinitions: attrs,
	})
	if err != nil {
		var inUse *ddbtypes.ResourceInUseException
		if !errors.As(err, &inUse) {
			return err
		}
		// Already exists, created by a concurrent test binary racing this
		// same shared table — but "exists" isn't "active": fall through
		// to the waiter rather than return early, so a caller here right
		// after doesn't hit the table mid-CREATING.
	}

	waiter := awsdynamodb.NewTableExistsWaiter(client)
	if err := waiter.Wait(ctx, &awsdynamodb.DescribeTableInput{TableName: aws.String(name)}, 30*time.Second); err != nil {
		return err
	}

	// A LocalStack that outlived a schema change still holds the old table
	// under the same name, and would otherwise hand tests the wrong shape.
	describe, err := client.DescribeTable(ctx, &awsdynamodb.DescribeTableInput{TableName: aws.String(name)})
	if err != nil {
		return err
	}
	if len(describe.Table.KeySchema) != len(keys) {
		return fmt.Errorf("%s exists with a different key schema; delete it or restart LocalStack", name)
	}
	return nil
}

// EnsureEntryIDIndex adds the entryId GSI to the log table if it isn't
// there yet — a separate, idempotent step since CreateTable's shape is
// shared by every table here, most needing no GSI.
func EnsureEntryIDIndex(ctx context.Context, client *awsdynamodb.Client, tableName string) error {
	return ensureIndex(ctx, client, tableName, index{name: logdynamodb.EntryIDIndexName, hash: "entryId", projection: ddbtypes.ProjectionTypeKeysOnly})
}

// EnsureAccountIDIndex adds the accountId GSI to the sessions table if it
// isn't there yet — see auth/dynamodb.DeleteAllSessions.
func EnsureAccountIDIndex(ctx context.Context, client *awsdynamodb.Client, tableName string) error {
	return ensureIndex(ctx, client, tableName, index{name: authdynamodb.AccountIDIndexName, hash: "accountId", projection: ddbtypes.ProjectionTypeKeysOnly})
}

// EnsureCircleIndexes adds the circles table's three GSIs, matching
// circles_table.tf. One at a time: DynamoDB accepts a single index
// creation per UpdateTable call.
func EnsureCircleIndexes(ctx context.Context, client *awsdynamodb.Client, tableName string) error {
	for _, idx := range []index{
		{name: circlesdynamodb.ByTypeReceivedIndex, hash: "pk", rangeKey: circlesdynamodb.ByTypeReceivedKey, projection: ddbtypes.ProjectionTypeAll},
		{name: circlesdynamodb.ByAccountIndex, hash: circlesdynamodb.ByAccountPK, rangeKey: "sk", projection: ddbtypes.ProjectionTypeKeysOnly},
		{name: circlesdynamodb.ByTypeUpdatedIndex, hash: "pk", rangeKey: circlesdynamodb.ByTypeUpdatedKey, projection: ddbtypes.ProjectionTypeAll},
	} {
		if err := ensureIndex(ctx, client, tableName, idx); err != nil {
			return fmt.Errorf("%s: %w", idx.name, err)
		}
	}
	return nil
}

// index is one GSI's shape. rangeKey is empty for a hash-only index.
type index struct {
	name       string
	hash       string
	rangeKey   string
	projection ddbtypes.ProjectionType
}

// ensureIndex adds a GSI to tableName if it isn't there yet — a separate,
// idempotent step since CreateTable's shape is shared by every table
// here, most needing no GSI at all.
func ensureIndex(ctx context.Context, client *awsdynamodb.Client, tableName string, idx index) error {
	indexName := idx.name
	describe, err := client.DescribeTable(ctx, &awsdynamodb.DescribeTableInput{TableName: aws.String(tableName)})
	if err != nil {
		return err
	}
	for _, gsi := range describe.Table.GlobalSecondaryIndexes {
		if aws.ToString(gsi.IndexName) == indexName {
			return nil
		}
	}

	keys := []ddbtypes.KeySchemaElement{{AttributeName: aws.String(idx.hash), KeyType: ddbtypes.KeyTypeHash}}
	attrs := []ddbtypes.AttributeDefinition{{AttributeName: aws.String(idx.hash), AttributeType: ddbtypes.ScalarAttributeTypeS}}
	if idx.rangeKey != "" {
		keys = append(keys, ddbtypes.KeySchemaElement{AttributeName: aws.String(idx.rangeKey), KeyType: ddbtypes.KeyTypeRange})
		attrs = append(attrs, ddbtypes.AttributeDefinition{AttributeName: aws.String(idx.rangeKey), AttributeType: ddbtypes.ScalarAttributeTypeS})
	}

	_, err = client.UpdateTable(ctx, &awsdynamodb.UpdateTableInput{
		TableName:            aws.String(tableName),
		AttributeDefinitions: attrs,
		GlobalSecondaryIndexUpdates: []ddbtypes.GlobalSecondaryIndexUpdate{
			{
				Create: &ddbtypes.CreateGlobalSecondaryIndexAction{
					IndexName:  aws.String(indexName),
					KeySchema:  keys,
					Projection: &ddbtypes.Projection{ProjectionType: idx.projection},
				},
			},
		},
	})
	if err != nil {
		var inUse *ddbtypes.ResourceInUseException
		if !errors.As(err, &inUse) {
			return err
		}
		// Racing test binary already adding it — fall through to the poll.
	}

	// No SDK waiter for GSI-active like NewTableExistsWaiter — poll directly.
	deadline := time.Now().Add(30 * time.Second)
	for {
		describe, err := client.DescribeTable(ctx, &awsdynamodb.DescribeTableInput{TableName: aws.String(tableName)})
		if err != nil {
			return err
		}
		for _, gsi := range describe.Table.GlobalSecondaryIndexes {
			if aws.ToString(gsi.IndexName) == indexName && gsi.IndexStatus == ddbtypes.IndexStatusActive {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s index on %s did not become active in time", indexName, tableName)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// CreateBucket creates a blob bucket. An already-owned bucket is
// success — see ProvisionSet.
func CreateBucket(ctx context.Context, client *awss3.Client, name string) error {
	_, err := client.CreateBucket(ctx, &awss3.CreateBucketInput{Bucket: aws.String(name)})
	if err != nil {
		var owned *s3types.BucketAlreadyOwnedByYou
		if errors.As(err, &owned) {
			return nil
		}
		return err
	}
	return nil
}
