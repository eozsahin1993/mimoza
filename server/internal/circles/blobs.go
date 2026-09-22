package circles

// UploadTarget is a presigned POST: where to send the encrypted bytes,
// and the fields S3 requires alongside them. The bytes never pass
// through the relay, so this is all a device gets.
type UploadTarget struct {
	URL    string
	Fields map[string]string
}

// MaxBlobSize caps one encrypted photo. The client compresses well under
// this; the cap bounds what a client that skips compression can store.
const MaxBlobSize = 2 * 1024 * 1024
