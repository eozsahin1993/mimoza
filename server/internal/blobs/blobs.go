// Package blobs is what every column shares about the bucket.
package blobs

import "errors"

// UploadTarget is a presigned POST: where to send the bytes, and the
// fields S3 checks them against.
type UploadTarget struct {
	URL    string
	Fields map[string]string
}

// ErrExists means bytes are already stored at this key. Keys are written
// once, so this is a refusal rather than a race to overwrite.
var ErrExists = errors.New("blobs: something is already stored at this key")
