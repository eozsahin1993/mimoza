package harness

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
)

// PostBlob sends bytes the way a device does: a multipart form straight
// to the presigned URL, carrying the fields the relay signed, with no
// session and no relay in the path. S3 itself applies the policy, so an
// upload that ignores it fails here rather than later.
func PostBlob(t *testing.T, url string, fields map[string]string, payload []byte) {
	t.Helper()

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for field, value := range fields {
		if err := form.WriteField(field, value); err != nil {
			t.Fatalf("writing %s: %v", field, err)
		}
	}
	part, err := form.CreateFormFile("file", "blob")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}

	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, url, &body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", form.FormDataContentType())

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("uploading: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		failure, _ := io.ReadAll(response.Body)
		t.Fatalf("upload failed: %d %s", response.StatusCode, failure)
	}
}
