package requests

type listResponse struct {
	Requests []requestResponse `json:"requests"`
}

type ListHandler struct{ Service *Service }
