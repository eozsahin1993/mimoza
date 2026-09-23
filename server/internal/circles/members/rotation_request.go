package members

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
)

// rotationRequest is the wire shape Remove and Leave share: the next
// content key, sealed once per remaining member, and the version those
// seals were made against — if another rotation landed first, the
// request is stale and refused rather than installing a key half the
// circle cannot open.
type rotationRequest struct {
	ExpectedVersion int64             `json:"expectedVersion"`
	Sealed          map[string]string `json:"sealed"`
}

// decodeRotation reads a rotationRequest body. badRequest is the message
// to send the caller when the body doesn't hold what a rotation needs;
// empty means it decoded cleanly.
func decodeRotation(r *http.Request) (expectedVersion int64, sealed map[string][]byte, badRequest string) {
	var body rotationRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return 0, nil, "body must be JSON"
	}
	if body.ExpectedVersion <= 0 {
		return 0, nil, "expectedVersion is required"
	}

	sealed = make(map[string][]byte, len(body.Sealed))
	for accountID, encoded := range body.Sealed {
		key, err := base64.StdEncoding.DecodeString(encoded)
		// Empty is valid base64 and would install a key that opens
		// nothing, leaving that member unable to read what comes next.
		if err != nil || len(key) == 0 {
			return 0, nil, "sealed keys must be non-empty base64"
		}
		sealed[accountID] = key
	}
	return body.ExpectedVersion, sealed, ""
}
