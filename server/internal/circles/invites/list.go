package invites

type listResponse struct {
	Invites []inviteResponse `json:"invites"`
}

type ListHandler struct{ Service *Service }
