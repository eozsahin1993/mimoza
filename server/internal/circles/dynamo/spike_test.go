// The storage design behind docs/RELAY_DESIGN.md, proven against a real
// DynamoDB rather than argued about: a post is one conditional put with
// no counter, the feed is a forward walk of by-type-updated, and a
// comment is one transaction that moves a count and the post's position
// in that index. What these tests are actually for is the claim the walk
// rests on — a device that has caught up never misses an entry, however
// the writes interleave.
package dynamo_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	circlesdynamo "mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/util/localstack"
)

// rewind is the step back a sync takes before its first read, covering a
// write that landed late or an index that lagged.
const rewind = 30 * time.Second

// A cursor position in an index: a time, and an id to break ties within
// the same millisecond.
type position struct {
	at time.Time
	id string
}

func (p position) key(prefix string) string {
	if p.id == "" {
		return fmt.Sprintf("%s#%013d", prefix, p.at.UnixMilli())
	}
	return fmt.Sprintf("%s#%013d#%s", prefix, p.at.UnixMilli(), p.id)
}

func TestForwardWalk_TheRewindIsWhatRecoversAConcurrentWrite(t *testing.T) {
	ctx := context.Background()
	table, ddb := table(t)
	circle := "circle#" + unique("concurrent")

	// Where a device that has just caught up would leave its cursor.
	cursor := position{at: time.Now()}

	const writers = 20
	var wg sync.WaitGroup
	ids := make([]string, writers)
	for i := range writers {
		ids[i] = fmt.Sprintf("post-%02d", i)
		wg.Add(1)
		go func(postID string) {
			defer wg.Done()
			// The stamp is taken before the write lands, as a handler's
			// would be, so commit order and stamp order need not agree.
			if err := putPost(ctx, ddb, table, circle, postID, time.Now()); err != nil {
				t.Errorf("put %s: %v", postID, err)
			}
		}(ids[i])
	}

	// A device syncing straight through the burst, never rewinding.
	live := map[string]struct{}{}
	for done := false; !done; {
		select {
		case <-waitFor(&wg):
			done = true
		default:
		}
		var page []item
		page, cursor = walk(ctx, t, ddb, table, circle, cursor, 5)
		for _, it := range page {
			live[it.id] = struct{}{}
		}
		time.Sleep(5 * time.Millisecond)
	}
	wg.Wait()
	for {
		page, next := walk(ctx, t, ddb, table, circle, cursor, 200)
		if len(page) == 0 {
			break
		}
		for _, it := range page {
			live[it.id] = struct{}{}
		}
		cursor = next
	}

	// The next sync steps back before its first read. That is the step
	// that picks up a write which committed behind the cursor.
	recovered := map[string]struct{}{}
	for _, it := range mustWalkAll(ctx, t, ddb, table, circle, position{at: cursor.at.Add(-rewind)}) {
		recovered[it.id] = struct{}{}
	}

	missed := 0
	for _, id := range ids {
		if _, ok := live[id]; !ok {
			missed++
		}
		if _, ok := recovered[id]; !ok {
			t.Errorf("%s survived the rewind unseen", id)
		}
	}
	t.Logf("a walk that never rewinds missed %d of %d concurrent posts", missed, writers)
}

// waitFor turns a WaitGroup into something selectable.
func waitFor(wg *sync.WaitGroup) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	return done
}

// Ties inside a millisecond are what the id suffix in the index key is
// for: without it a page boundary would either repeat a row or skip one.
func TestForwardWalk_PagesThroughOneMillisecondWithoutRepeatsOrSkips(t *testing.T) {
	ctx := context.Background()
	table, ddb := table(t)
	circle := "circle#" + unique("sameinstant")

	at := time.Now()
	const posts = 7
	for i := 0; i < posts; i++ {
		if err := putPost(ctx, ddb, table, circle, fmt.Sprintf("post-%02d", i), at); err != nil {
			t.Fatal(err)
		}
	}

	seen := map[string]int{}
	cursor := position{at: at.Add(-time.Millisecond)}
	for range posts + 2 {
		page, next := walk(ctx, t, ddb, table, circle, cursor, 2)
		cursor = next
		for _, it := range page {
			seen[it.id]++
		}
		if len(page) < 2 {
			// Short page: the walk is done, as it would be on a device.
			break
		}
	}

	if len(seen) != posts {
		t.Fatalf("walked %d posts, want %d", len(seen), posts)
	}
	for id, count := range seen {
		if count != 1 {
			t.Errorf("%s came back %d times across pages", id, count)
		}
	}
}

// A comment moves the post's position in the index, so a device that had
// already walked past that post is handed it again.
func TestForwardWalk_ReturnsAPostWhoseCommentCountChanged(t *testing.T) {
	ctx := context.Background()
	table, ddb := table(t)
	circle := "circle#" + unique("updated")

	postedAt := time.Now()
	if err := putPost(ctx, ddb, table, circle, "post-1", postedAt); err != nil {
		t.Fatal(err)
	}

	page, cursor := walk(ctx, t, ddb, table, circle, position{at: postedAt.Add(-time.Second)}, 200)
	if len(page) != 1 {
		t.Fatalf("expected the post in the first walk, got %d rows", len(page))
	}
	if again, _ := walk(ctx, t, ddb, table, circle, cursor, 200); len(again) != 0 {
		t.Fatalf("expected nothing new, got %d rows", len(again))
	}

	if err := comment(ctx, ddb, table, circle, "post-1", "comment-1", time.Now()); err != nil {
		t.Fatal(err)
	}

	after, _ := walk(ctx, t, ddb, table, circle, cursor, 200)
	if len(after) != 1 || after[0].id != "post-1" {
		t.Fatalf("expected the commented post to re-enter the walk, got %v", after)
	}
	if after[0].commentCount != 1 {
		t.Errorf("commentCount = %d, want 1", after[0].commentCount)
	}
}

// Every comment is its own row and one delta on the post, so concurrent
// commenters cannot lose each other's count the way a read-modify-write
// would.
func TestComments_ConcurrentCommentsKeepAnExactCount(t *testing.T) {
	ctx := context.Background()
	table, ddb := table(t)
	circle := "circle#" + unique("comments")

	if err := putPost(ctx, ddb, table, circle, "post-1", time.Now()); err != nil {
		t.Fatal(err)
	}

	const commenters = 20
	var wg sync.WaitGroup
	for i := range commenters {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			if err := comment(ctx, ddb, table, circle, "post-1", fmt.Sprintf("comment-%02d", n), time.Now()); err != nil {
				t.Errorf("comment %d: %v", n, err)
			}
		}(i)
	}
	wg.Wait()

	post, err := ddb.GetItem(ctx, &awsdynamodb.GetItemInput{
		TableName:      aws.String(table),
		Key:            map[string]ddbtypes.AttributeValue{"pk": s(circle), "sk": s("entry#post-1")},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := number(t, post.Item["commentCount"]); got != commenters {
		t.Errorf("commentCount = %d, want %d", got, commenters)
	}

	children, err := ddb.Query(ctx, &awsdynamodb.QueryInput{
		TableName:              aws.String(table),
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":pk":     s(circle),
			":prefix": s("child#post-1#comment#"),
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	if int(children.Count) != commenters {
		t.Errorf("stored %d comment rows, want %d", children.Count, commenters)
	}
}

// A retried post is the same row, not a second one.
func TestPost_ARepeatedEntryIDIsNotASecondPost(t *testing.T) {
	ctx := context.Background()
	table, ddb := table(t)
	circle := "circle#" + unique("idempotent")

	at := time.Now()
	if err := putPost(ctx, ddb, table, circle, "post-1", at); err != nil {
		t.Fatal(err)
	}
	err := putPost(ctx, ddb, table, circle, "post-1", at.Add(time.Second))
	var failed *ddbtypes.ConditionalCheckFailedException
	if !errors.As(err, &failed) {
		t.Fatalf("expected a conditional check failure on the second put, got %v", err)
	}

	page, _ := walk(ctx, t, ddb, table, circle, position{at: at.Add(-time.Second)}, 200)
	if len(page) != 1 {
		t.Fatalf("expected one post, got %d", len(page))
	}
}

// --- the shapes under test ---------------------------------------------

// putPost writes one post the way the append handler will: a conditional
// put keyed by the client's own id, with both index keys stamped by the
// relay. No counter, no transaction, nothing to retry.
func putPost(ctx context.Context, ddb *awsdynamodb.Client, table, circle, postID string, at time.Time) error {
	_, err := ddb.PutItem(ctx, &awsdynamodb.PutItemInput{
		TableName: aws.String(table),
		Item: map[string]ddbtypes.AttributeValue{
			"pk":                            s(circle),
			"sk":                            s("entry#" + postID),
			"type":                          s("post"),
			"receivedAt":                    n(at.UnixMilli()),
			"updatedAt":                     n(at.UnixMilli()),
			"commentCount":                  n(0),
			circlesdynamo.ByTypeReceivedKey: s(position{at: at, id: postID}.key("post")),
			circlesdynamo.ByTypeUpdatedKey:  s(position{at: at, id: postID}.key("post")),
		},
		ConditionExpression: aws.String("attribute_not_exists(sk)"),
	})
	return err
}

// comment writes the child row and moves the post's count and index
// position in one transaction, retrying only the contention DynamoDB
// reports on the post item itself.
func comment(ctx context.Context, ddb *awsdynamodb.Client, table, circle, postID, commentID string, at time.Time) error {
	for attempt := range 5 {
		_, err := ddb.TransactWriteItems(ctx, &awsdynamodb.TransactWriteItemsInput{
			TransactItems: []ddbtypes.TransactWriteItem{
				{Put: &ddbtypes.Put{
					TableName: aws.String(table),
					Item: map[string]ddbtypes.AttributeValue{
						"pk":         s(circle),
						"sk":         s("child#" + postID + "#comment#" + commentID),
						"receivedAt": n(at.UnixMilli()),
					},
					ConditionExpression: aws.String("attribute_not_exists(sk)"),
				}},
				{Update: &ddbtypes.Update{
					TableName: aws.String(table),
					Key:       map[string]ddbtypes.AttributeValue{"pk": s(circle), "sk": s("entry#" + postID)},
					UpdateExpression: aws.String(
						"ADD commentCount :one SET updatedAt = :at, " + circlesdynamo.ByTypeUpdatedKey + " = :key",
					),
					ConditionExpression: aws.String("attribute_exists(sk) AND attribute_not_exists(deletedAt)"),
					ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
						":one": n(1),
						":at":  n(at.UnixMilli()),
						":key": s(position{at: at, id: postID}.key("post")),
					},
				}},
			},
		})
		if err == nil {
			return nil
		}
		var cancelled *ddbtypes.TransactionCanceledException
		if !errors.As(err, &cancelled) || !onlyConflicts(cancelled) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 20 * time.Millisecond)
	}
	return fmt.Errorf("comment %s: still conflicting after 5 attempts", commentID)
}

// onlyConflicts reports whether every reason DynamoDB gave is contention
// on an item — the one class worth retrying, since the write itself was
// valid. A failed condition means someone else's write already stands.
func onlyConflicts(err *ddbtypes.TransactionCanceledException) bool {
	conflicted := false
	for _, reason := range err.CancellationReasons {
		switch aws.ToString(reason.Code) {
		case "None":
		case "TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded":
			conflicted = true
		default:
			return false
		}
	}
	return conflicted
}

// walk is one forward read: the next rows after a position in
// by-type-updated, and where to resume. A full page resumes exactly after
// its last row; a short page resumes at the newest time it saw, which is
// what the next sync rewinds from.
func walk(ctx context.Context, t *testing.T, ddb *awsdynamodb.Client, table, circle string, from position, limit int32) ([]item, position) {
	t.Helper()
	out, err := ddb.Query(ctx, &awsdynamodb.QueryInput{
		TableName:              aws.String(table),
		IndexName:              aws.String(circlesdynamo.ByTypeUpdatedIndex),
		KeyConditionExpression: aws.String("pk = :pk AND " + circlesdynamo.ByTypeUpdatedKey + " > :from"),
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":pk":   s(circle),
			":from": s(from.key("post")),
		},
		ScanIndexForward: aws.Bool(true),
		Limit:            aws.Int32(limit),
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	items := make([]item, 0, len(out.Items))
	for _, raw := range out.Items {
		id, _ := raw["sk"].(*ddbtypes.AttributeValueMemberS)
		items = append(items, item{
			id:           id.Value[len("entry#"):],
			updatedAt:    time.UnixMilli(number(t, raw["updatedAt"])),
			commentCount: number(t, raw["commentCount"]),
		})
	}
	if len(items) == 0 {
		return items, from
	}
	last := items[len(items)-1]
	return items, position{at: last.updatedAt, id: last.id}
}

type item struct {
	id           string
	updatedAt    time.Time
	commentCount int64
}

// --- plumbing -----------------------------------------------------------

func table(t *testing.T) (string, *awsdynamodb.Client) {
	t.Helper()
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

	names := localstack.Shared()
	if err := localstack.ProvisionSet(ctx, ddb, s3, names); err != nil {
		t.Fatal(err)
	}
	return names.CirclesTableName, ddb
}

func unique(what string) string {
	return fmt.Sprintf("%s-%d", what, time.Now().UnixNano())
}

func uniqueIDs(items []item) map[string]struct{} {
	ids := make(map[string]struct{}, len(items))
	for _, it := range items {
		ids[it.id] = struct{}{}
	}
	return ids
}

func s(v string) ddbtypes.AttributeValue { return &ddbtypes.AttributeValueMemberS{Value: v} }

func n(v int64) ddbtypes.AttributeValue {
	return &ddbtypes.AttributeValueMemberN{Value: fmt.Sprintf("%d", v)}
}

func number(t *testing.T, v ddbtypes.AttributeValue) int64 {
	t.Helper()
	attr, ok := v.(*ddbtypes.AttributeValueMemberN)
	if !ok {
		t.Fatalf("expected a number, got %T", v)
	}
	var parsed int64
	if _, err := fmt.Sscanf(attr.Value, "%d", &parsed); err != nil {
		t.Fatalf("parse %q: %v", attr.Value, err)
	}
	return parsed
}

// mustWalkAll pages a walk to exhaustion.
func mustWalkAll(ctx context.Context, t *testing.T, ddb *awsdynamodb.Client, table, circle string, from position) []item {
	t.Helper()
	var all []item
	cursor := from
	for {
		page, next := walk(ctx, t, ddb, table, circle, cursor, 200)
		all = append(all, page...)
		if len(page) < 200 {
			return all
		}
		cursor = next
	}
}

// The rewind is a window, and a window can always be beaten: a write can
// land behind it, whether because the handler stamped it long before it
// committed or because the index took its time. What catches that is not
// a wider window but a count — the relay's own count of posts, against
// what the device holds. Both are read through the same index, so a post
// that has not propagated is missing from both and raises no false
// alarm; once it propagates, the counts disagree and the device walks
// backward to find it.
func TestCompleteness_ACountCatchesAPostThatLandedBehindTheRewind(t *testing.T) {
	ctx := context.Background()
	table, ddb := table(t)
	circle := "circle#" + unique("behind")

	start := time.Now()
	for i := range 3 {
		if err := putPost(ctx, ddb, table, circle, fmt.Sprintf("post-%02d", i), start.Add(time.Duration(i)*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
	}
	held := map[string]struct{}{}
	cursor := position{at: start.Add(-time.Second)}
	for _, it := range mustWalkAll(ctx, t, ddb, table, circle, cursor) {
		held[it.id] = struct{}{}
		cursor = position{at: it.updatedAt, id: it.id}
	}
	if len(held) != 3 {
		t.Fatalf("expected 3 posts in the first walk, got %d", len(held))
	}

	// A write whose stamp is older than anything the rewind would reach.
	if err := putPost(ctx, ddb, table, circle, "post-late", start.Add(-10*rewind)); err != nil {
		t.Fatal(err)
	}

	// Even rewound, the forward walk cannot see it: it sits behind.
	for _, it := range mustWalkAll(ctx, t, ddb, table, circle, position{at: cursor.at.Add(-rewind)}) {
		if it.id == "post-late" {
			t.Fatal("expected the rewind to miss a post stamped before it")
		}
	}

	// The count does see it.
	total := countPosts(ctx, t, ddb, table, circle)
	if total != int32(len(held))+1 {
		t.Fatalf("relay count = %d, want %d", total, len(held)+1)
	}
	if int(total) == len(held) {
		t.Fatal("the count agreed with the device, so nothing would have prompted a reconcile")
	}

	// Which is what sends the device backward through arrival order,
	// where nothing ever moves.
	found := false
	for _, it := range walkBackward(ctx, t, ddb, table, circle) {
		if it.id == "post-late" {
			found = true
		}
	}
	if !found {
		t.Error("the backward walk did not find the missing post")
	}
}

// countPosts is the relay's side of the completeness check: how many
// posts this circle has, without reading them.
func countPosts(ctx context.Context, t *testing.T, ddb *awsdynamodb.Client, table, circle string) int32 {
	t.Helper()
	var total int32
	var start map[string]ddbtypes.AttributeValue
	for {
		out, err := ddb.Query(ctx, &awsdynamodb.QueryInput{
			TableName:              aws.String(table),
			IndexName:              aws.String(circlesdynamo.ByTypeReceivedIndex),
			KeyConditionExpression: aws.String("pk = :pk AND begins_with(" + circlesdynamo.ByTypeReceivedKey + ", :prefix)"),
			ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
				":pk":     s(circle),
				":prefix": s("post#"),
			},
			Select:            ddbtypes.SelectCount,
			ExclusiveStartKey: start,
		})
		if err != nil {
			t.Fatalf("count: %v", err)
		}
		total += out.Count
		if len(out.LastEvaluatedKey) == 0 {
			return total
		}
		start = out.LastEvaluatedKey
	}
}

// walkBackward is history paging: arrival order, newest first, on the one
// index whose keys never move.
func walkBackward(ctx context.Context, t *testing.T, ddb *awsdynamodb.Client, table, circle string) []item {
	t.Helper()
	out, err := ddb.Query(ctx, &awsdynamodb.QueryInput{
		TableName:              aws.String(table),
		IndexName:              aws.String(circlesdynamo.ByTypeReceivedIndex),
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(" + circlesdynamo.ByTypeReceivedKey + ", :prefix)"),
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":pk":     s(circle),
			":prefix": s("post#"),
		},
		ScanIndexForward: aws.Bool(false),
		Limit:            aws.Int32(200),
	})
	if err != nil {
		t.Fatalf("backward walk: %v", err)
	}
	items := make([]item, 0, len(out.Items))
	for _, raw := range out.Items {
		id := raw["sk"].(*ddbtypes.AttributeValueMemberS).Value
		items = append(items, item{id: id[len("entry#"):], updatedAt: time.UnixMilli(number(t, raw["updatedAt"]))})
	}
	return items
}
