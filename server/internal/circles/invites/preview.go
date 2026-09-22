package invites

type previewResponse struct {
	CircleID    string `json:"circleId"`
	Name        string `json:"name"`
	MemberCount int    `json:"memberCount"`
	InvitedBy   string `json:"invitedBy"`
}

type PreviewHandler struct{ Service *Service }
