package invites

type previewResponse struct {
	CircleID    string `json:"circleId"`
	Name        string `json:"name"`
	MemberCount int    `json:"memberCount"`
	InvitedBy   string `json:"invitedBy"`
	// ProfilePictureURL is a signed URL for the inviter's picture,
	// already resolved — see Service.Preview. Absent when they have none.
	ProfilePictureURL string `json:"profilePictureUrl,omitempty"`
}

type PreviewHandler struct{ Service *Service }
