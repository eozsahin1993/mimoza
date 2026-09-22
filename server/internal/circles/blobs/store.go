package blobs

import (
	"mimoza-relay/internal/circles/dynamo"
	circless3 "mimoza-relay/internal/circles/s3"
)

// Store is this slice's reads against the circles table: who is asking,
// and whether the post they are asking about is still there. The bytes
// themselves are the bucket's, not this table's.
type Store struct {
	*dynamo.Table
}

func NewStore(table *dynamo.Table) *Store { return &Store{Table: table} }

var _ store = (*Store)(nil)

// PostKey and CoverKey name where the bytes live. They are here rather
// than inlined so the handler, the store and a deletion elsewhere all
// compute the same key.
func PostKey(circleID, postID string) string   { return circless3.PostKey(circleID, postID) }
func CoverKey(circleID, coverID string) string { return circless3.CoverKey(circleID, coverID) }
