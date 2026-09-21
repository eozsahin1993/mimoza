// Command decryptlog is a developer-only debugging tool: given a circle's
// syncId and its content key(s), it fetches every item in that circle's
// log partition, decrypts each entry, and writes the result to a local
// file — in the same order the log itself has (sk-ascending, i.e. real
// replay order), never mutating or copying anything server-side.
//
// It exists to eyeball whether entries the client wrote actually decrypt
// to what's expected, without hand-decoding base64/JSON or reaching for
// the app itself. It deliberately never writes decrypted content back to
// DynamoDB (or anywhere but local disk/stdout) — persisting plaintext of
// real photo captions/names in the cloud would recreate exactly what
// end-to-end encryption here exists to avoid. Entries live one partition
// per syncId, sk-ordered "meta#"/"content#", each ciphertext holding
// {type, payload, authorPubkey, signature} — see
// internal/synclog/dynamodb/store.go for the concrete shape.
//
// Usage:
//
//	go run ./cmd/decryptlog --table <log-table> --sync-id <syncId> --content-key <hex> [--out entries.json]
//
// syncId is random and relay-facing — not derived from any key, so unlike
// the pre-redesign circleLogId it can't be recomputed here and must be
// passed in directly (read it off the device's local `circles.sync_id`
// column, or a bootstrapCircle/appendEntry call log).
//
// Content keys are versioned — removing a member rotates in a fresh key
// for the survivors, so older entries stay under older versions — pass one
// --content-key per version this circle has ever used, as "<version>=<hex>"
// (bare hex with no "=" is treated as version 1). An entry whose keyVersion
// has no matching key is reported with an error instead of decrypted.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"golang.org/x/crypto/chacha20poly1305"

	"mimoza-relay/internal/util/dynamoutil"
)

const nonceLength = chacha20poly1305.NonceSizeX // 24 bytes — must match app/src/services/crypto.ts's NONCE_LENGTH

// logEntryEnvelope mirrors app/src/domain/usecases/circle/log-entry.ts's
// LogEntryEnvelope — what an entry's ciphertext decrypts to. Payload is
// `json.RawMessage` since its real shape (post/comment/reaction/...) is
// named by Type and this tool has no reason to know it in advance.
type logEntryEnvelope struct {
	Type         string          `json:"type"`
	Payload      json.RawMessage `json:"payload"`
	AuthorPubkey string          `json:"authorPubkey"`
	Signature    string          `json:"signature"`
}

// decryptedItem is what gets written out per DynamoDB item — one of
// #control (dumped as-is; it's already relay-visible plaintext) or a
// meta#/content# entry (decrypted).
type decryptedItem struct {
	SortKey    string            `json:"sk"`
	Namespace  string            `json:"namespace,omitempty"`
	Epoch      int64             `json:"epoch,omitempty"`
	KeyVersion int64             `json:"keyVersion,omitempty"`
	ReceivedAt int64             `json:"receivedAt,omitempty"`
	Entry      *logEntryEnvelope `json:"entry,omitempty"`
	Control    map[string]any    `json:"control,omitempty"`
	Error      string            `json:"error,omitempty"`
}

// contentKeys collects repeatable `--content-key` flags into a
// version->key map — flag.Value rather than flag.String since a circle
// can have more than one content-key version alive across its history.
type contentKeys map[int64][]byte

func (k contentKeys) String() string { return "" }

func (k contentKeys) Set(raw string) error {
	version, hexKey := int64(1), raw
	if idx := strings.IndexByte(raw, '='); idx >= 0 {
		v, err := strconv.ParseInt(raw[:idx], 10, 64)
		if err != nil {
			return fmt.Errorf("bad version in %q: %w", raw, err)
		}
		version, hexKey = v, raw[idx+1:]
	}
	key, err := hex.DecodeString(strings.TrimSpace(hexKey))
	if err != nil || len(key) != 32 {
		return fmt.Errorf("content key for version %d must be 64 hex characters (32 bytes): %v", version, err)
	}
	k[version] = key
	return nil
}

func main() {
	tableName := flag.String("table", "", "DynamoDB log table name (required)")
	syncID := flag.String("sync-id", "", "the circle's syncId — random, not derivable; read it from the device's circles.sync_id (required)")
	endpoint := flag.String("endpoint", "", "override the AWS endpoint, e.g. http://localhost:4566 for LocalStack (default: real AWS)")
	region := flag.String("region", "", "override the AWS region (default: whatever the environment/profile resolves to)")
	outPath := flag.String("out", "", "write decrypted entries as JSON to this file (default: stdout)")
	keys := make(contentKeys)
	flag.Var(keys, "content-key", `content key as "<version>=<hex>" (bare hex means version 1) — repeat for a circle with multiple key versions`)
	flag.Parse()

	if *tableName == "" {
		log.Fatal("--table is required")
	}
	if *syncID == "" {
		log.Fatal("--sync-id is required")
	}
	if len(keys) == 0 {
		log.Fatal("at least one --content-key is required")
	}

	ctx := context.Background()
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(*region))
	if err != nil {
		log.Fatalf("failed to load AWS config: %v", err)
	}
	client := dynamodb.NewFromConfig(awsCfg, func(o *dynamodb.Options) {
		if *endpoint != "" {
			o.BaseEndpoint = endpoint
		}
	})

	items, err := queryAllItems(ctx, client, *tableName, *syncID)
	if err != nil {
		log.Fatalf("failed to query %s: %v", *tableName, err)
	}

	results := make([]decryptedItem, 0, len(items))
	for _, item := range items {
		sk, _ := dynamoutil.AttrString(item, dynamoutil.SKAttr)
		results = append(results, decodeItem(sk, item, keys))
	}
	log.Printf("wrote %d items (from syncId %s)", len(results), *syncID)

	out, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		log.Fatalf("failed to marshal output: %v", err)
	}
	if *outPath == "" {
		os.Stdout.Write(out)
		os.Stdout.Write([]byte("\n"))
		return
	}
	if err := os.WriteFile(*outPath, out, 0o600); err != nil {
		log.Fatalf("failed to write %s: %v", *outPath, err)
	}
	log.Printf("wrote %s", *outPath)
}

// decodeItem dispatches on sk shape: "#control" is dumped as plaintext
// (it's already relay-visible), "idem#..." markers are reported without
// attempting to decrypt (they carry no ciphertext), and "meta#.../
// content#..." entries are decrypted against the matching content-key
// version.
func decodeItem(sk string, item map[string]types.AttributeValue, keys contentKeys) decryptedItem {
	result := decryptedItem{SortKey: sk}

	if sk == "#control" {
		result.Control = decodeControlItem(item)
		return result
	}
	if strings.HasPrefix(sk, "idem#") {
		result.Error = "idempotency marker — no ciphertext to decrypt"
		return result
	}

	ns := sk
	if idx := strings.IndexByte(sk, '#'); idx >= 0 {
		ns = sk[:idx]
	}
	result.Namespace = ns
	result.Epoch, _ = dynamoutil.AttrInt(item, "epoch")
	result.ReceivedAt, _ = dynamoutil.AttrInt(item, "receivedAt")
	keyVersion, err := dynamoutil.AttrInt(item, "keyVersion")
	if err != nil {
		result.Error = "missing keyVersion attribute"
		return result
	}
	result.KeyVersion = keyVersion

	key, ok := keys[keyVersion]
	if !ok {
		result.Error = fmt.Sprintf("no --content-key provided for version %d", keyVersion)
		return result
	}

	ciphertext, ok := item["encryptedMeta"].(*types.AttributeValueMemberB)
	if !ok {
		result.Error = "missing or non-binary encryptedMeta attribute"
		return result
	}
	plaintext, err := decrypt(ciphertext.Value, key)
	if err != nil {
		result.Error = fmt.Sprintf("decrypt failed (wrong content key for this version?): %v", err)
		return result
	}

	var entry logEntryEnvelope
	if err := json.Unmarshal(plaintext, &entry); err != nil {
		result.Error = fmt.Sprintf("decrypted, but not a valid log-entry envelope: %v", err)
		return result
	}
	result.Entry = &entry
	return result
}

// decodeControlItem renders #control's attributes generically rather than
// a typed struct — this tool only reads it for eyeballing, and a
// hand-maintained mirror of internal/synclog/dynamodb.go's
// control-state shape would just be one more place to keep in sync.
func decodeControlItem(item map[string]types.AttributeValue) map[string]any {
	control := make(map[string]any, len(item))
	for name, attr := range item {
		if name == dynamoutil.PKAttr || name == dynamoutil.SKAttr {
			continue
		}
		switch v := attr.(type) {
		case *types.AttributeValueMemberS:
			control[name] = v.Value
		case *types.AttributeValueMemberN:
			control[name] = v.Value
		case *types.AttributeValueMemberSS:
			control[name] = v.Value
		default:
			control[name] = fmt.Sprintf("%v", attr)
		}
	}
	return control
}

// decrypt mirrors app/src/services/crypto.ts's decrypt: split the leading
// 24-byte nonce off, then XChaCha20-Poly1305-open the rest.
func decrypt(ciphertext, key []byte) ([]byte, error) {
	if len(ciphertext) < nonceLength {
		return nil, fmt.Errorf("ciphertext shorter than nonce (%d bytes)", nonceLength)
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	nonce, box := ciphertext[:nonceLength], ciphertext[nonceLength:]
	return aead.Open(nil, nonce, box, nil)
}

// queryAllItems pages through every item in syncID's partition —
// #control, every meta#/content# entry, and every idem# marker — oldest
// first (DynamoDB's default Query order), following LastEvaluatedKey
// until the whole partition's been read. Unlike the relay's own read path
// (internal/synclog/dynamodb.Read), this has no reason to cap
// pages or split by namespace: it's meant to dump everything for
// inspection in one shot.
func queryAllItems(ctx context.Context, client *dynamodb.Client, tableName, syncID string) ([]map[string]types.AttributeValue, error) {
	var items []map[string]types.AttributeValue
	var startKey map[string]types.AttributeValue
	for {
		out, err := client.Query(ctx, &dynamodb.QueryInput{
			TableName:                 &tableName,
			KeyConditionExpression:    strPtr("#pk = :pk"),
			ExpressionAttributeNames:  map[string]string{"#pk": dynamoutil.PKAttr},
			ExpressionAttributeValues: map[string]types.AttributeValue{":pk": &types.AttributeValueMemberS{Value: syncID}},
			ExclusiveStartKey:         startKey,
		})
		if err != nil {
			return nil, err
		}
		items = append(items, out.Items...)
		if len(out.LastEvaluatedKey) == 0 {
			return items, nil
		}
		startKey = out.LastEvaluatedKey
	}
}

func strPtr(s string) *string { return &s }
