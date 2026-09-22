package requests

type approveRequest struct {
	// Sealed is every content key version, sealed to the requester's
	// public key: version as a string, because JSON object keys are.
	Sealed map[string]string `json:"sealed"`
}

type ApproveHandler struct{ Service *Service }
