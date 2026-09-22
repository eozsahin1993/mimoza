package requests

type createRequest struct {
	// PublicKey is what the approver seals the content keys to.
	PublicKey string `json:"publicKey"`
}

type CreateHandler struct{ Service *Service }
