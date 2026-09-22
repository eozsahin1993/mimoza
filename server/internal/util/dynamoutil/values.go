package dynamoutil

import (
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Writing an attribute. Every store in this codebase builds items by
// hand rather than through attributevalue marshalling, so these are the
// constructors it builds them from.

func Str(v string) types.AttributeValue { return &types.AttributeValueMemberS{Value: v} }

func Num(v int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(v, 10)}
}

func Binary(v []byte) types.AttributeValue { return &types.AttributeValueMemberB{Value: v} }

func Bool(v bool) types.AttributeValue { return &types.AttributeValueMemberBOOL{Value: v} }

// Millis writes a time as an int64 of milliseconds, matching the
// resolution the index keys sort on.
func Millis(t time.Time) types.AttributeValue { return Num(t.UnixMilli()) }

// Reading one back. These are the AttrX readers above with the "was it
// there" dropped: a row this relay wrote has the attributes this relay
// writes, and a caller that cannot act on the difference should not have
// to write the second return value out.

func StringAt(item map[string]types.AttributeValue, attr string) string {
	v, _ := AttrString(item, attr)
	return v
}

func IntAt(item map[string]types.AttributeValue, attr string) int64 {
	v, _ := AttrInt(item, attr)
	return v
}

func BytesAt(item map[string]types.AttributeValue, attr string) []byte {
	v, _ := AttrBytes(item, attr)
	return v
}

func BoolAt(item map[string]types.AttributeValue, attr string) bool { return AttrBool(item, attr) }

// TimeAt reads a millisecond stamp back. A missing or zero stamp is the
// zero time, which is how an unset optional stamp reads.
func TimeAt(item map[string]types.AttributeValue, attr string) time.Time {
	v, err := AttrInt(item, attr)
	if err != nil || v == 0 {
		return time.Time{}
	}
	return time.UnixMilli(v)
}
