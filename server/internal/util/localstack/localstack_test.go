package localstack_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	circlesdynamo "mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/util/localstack"
)

// The provisioned shapes have to match the Terraform ones, since LocalStack
// enforces neither and a mismatch only shows once deployed.
func TestProvisionSet_CreatesTheNewTablesWithTheirKeysAndIndexes(t *testing.T) {
	ctx := context.Background()
	cfg, err := localstack.Config(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ddb := awsdynamodb.NewFromConfig(cfg)
	s3 := awss3.NewFromConfig(cfg, func(o *awss3.Options) { o.UsePathStyle = true })
	if _, err := ddb.ListTables(ctx, &awsdynamodb.ListTablesInput{Limit: aws.Int32(1)}); err != nil {
		if localstack.Required() {
			t.Fatalf("LocalStack unreachable: %v", err)
		}
		t.Skipf("LocalStack unreachable: %v", err)
	}

	names := localstack.Unique(fmt.Sprintf("provision-%d", time.Now().UnixNano()))
	if err := localstack.ProvisionSet(ctx, ddb, s3, names); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { localstack.TeardownSet(context.Background(), ddb, s3, names) })

	accounts := describe(t, ddb, names.AccountsTableName)
	assertKeys(t, names.AccountsTableName, accounts.KeySchema, "pk", "sk")

	circles := describe(t, ddb, names.CirclesTableName)
	assertKeys(t, names.CirclesTableName, circles.KeySchema, "pk", "sk")

	want := map[string]struct {
		hash, rangeKey string
		projection     ddbtypes.ProjectionType
	}{
		circlesdynamo.ByTypeReceivedIndex: {"pk", circlesdynamo.ByTypeReceivedKey, ddbtypes.ProjectionTypeAll},
		circlesdynamo.ByAccountIndex:      {circlesdynamo.ByAccountPK, "sk", ddbtypes.ProjectionTypeKeysOnly},
		circlesdynamo.ByTypeUpdatedIndex:  {"pk", circlesdynamo.ByTypeUpdatedKey, ddbtypes.ProjectionTypeAll},
	}
	if len(circles.GlobalSecondaryIndexes) != len(want) {
		t.Fatalf("circles table has %d indexes, want %d", len(circles.GlobalSecondaryIndexes), len(want))
	}
	for _, gsi := range circles.GlobalSecondaryIndexes {
		name := aws.ToString(gsi.IndexName)
		w, ok := want[name]
		if !ok {
			t.Errorf("unexpected index %q", name)
			continue
		}
		assertKeys(t, name, gsi.KeySchema, w.hash, w.rangeKey)
		if gsi.Projection == nil || gsi.Projection.ProjectionType != w.projection {
			t.Errorf("%s projection = %v, want %s", name, gsi.Projection, w.projection)
		}
	}

	// A second run over the same set is a no-op, not an error.
	if err := localstack.ProvisionSet(ctx, ddb, s3, names); err != nil {
		t.Fatalf("second ProvisionSet: %v", err)
	}
}

func describe(t *testing.T, ddb *awsdynamodb.Client, table string) *ddbtypes.TableDescription {
	t.Helper()
	out, err := ddb.DescribeTable(context.Background(), &awsdynamodb.DescribeTableInput{TableName: aws.String(table)})
	if err != nil {
		t.Fatalf("describe %s: %v", table, err)
	}
	return out.Table
}

func assertKeys(t *testing.T, what string, schema []ddbtypes.KeySchemaElement, hash, rangeKey string) {
	t.Helper()
	var gotHash, gotRange string
	for _, k := range schema {
		switch k.KeyType {
		case ddbtypes.KeyTypeHash:
			gotHash = aws.ToString(k.AttributeName)
		case ddbtypes.KeyTypeRange:
			gotRange = aws.ToString(k.AttributeName)
		}
	}
	if gotHash != hash || gotRange != rangeKey {
		t.Errorf("%s keys = (%q, %q), want (%q, %q)", what, gotHash, gotRange, hash, rangeKey)
	}
}

func TestCreateTable_RefusesAnExistingTableWithADifferentKeySchema(t *testing.T) {
	ctx := context.Background()
	cfg, err := localstack.Config(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ddb := awsdynamodb.NewFromConfig(cfg)
	if _, err := ddb.ListTables(ctx, &awsdynamodb.ListTablesInput{Limit: aws.Int32(1)}); err != nil {
		if localstack.Required() {
			t.Fatalf("LocalStack unreachable: %v", err)
		}
		t.Skipf("LocalStack unreachable: %v", err)
	}

	name := fmt.Sprintf("schema-guard-%d", time.Now().UnixNano())
	if err := localstack.CreateTable(ctx, ddb, name, localstack.HashOnly); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = ddb.DeleteTable(context.Background(), &awsdynamodb.DeleteTableInput{TableName: aws.String(name)})
	})

	if err := localstack.CreateTable(ctx, ddb, name, localstack.HashOnly); err != nil {
		t.Fatalf("same schema again: %v", err)
	}
	if err := localstack.CreateTable(ctx, ddb, name, localstack.WithSortKey); err == nil {
		t.Fatal("a sorted table over an existing hash-only one was accepted")
	}
}
