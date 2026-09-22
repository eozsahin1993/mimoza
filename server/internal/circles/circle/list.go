package circle

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

// membershipResponse is one row of what a device syncs against: enough
// to decide whether anything about this circle needs fetching, and
// nothing that would need fetching itself.
type membershipResponse struct {
	CircleID      string `json:"circleId"`
	Name          string `json:"name"`
	CoverID       string `json:"coverId,omitempty"`
	Role          string `json:"role"`
	NotifyLevel   string `json:"notifyLevel"`
	KeyVersion    int64  `json:"keyVersion"`
	RosterVersion int64  `json:"rosterVersion"`
	LastEntryAt   int64  `json:"lastEntryAt,omitempty"`
	NeedsRewrap   bool   `json:"needsRewrap,omitempty"`
}

type listResponse struct {
	Circles []membershipResponse `json:"circles"`
}

type ListHandler struct {
	Service *Service
}

// A sync starts here: the versions in each row are what a device
// compares against its own to know what to fetch next.
func (h *ListHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	memberships, err := h.Service.List(r.Context(), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	body := listResponse{Circles: make([]membershipResponse, 0, len(memberships))}
	for _, membership := range memberships {
		body.Circles = append(body.Circles, membershipResponse{
			CircleID:      membership.Circle.ID,
			Name:          membership.Circle.Name,
			CoverID:       membership.Circle.CoverID,
			Role:          membership.Role,
			NotifyLevel:   membership.NotifyLevel,
			KeyVersion:    membership.Circle.KeyVersion,
			RosterVersion: membership.Circle.RosterVersion,
			LastEntryAt:   millis(membership.Circle.LastEntryAt),
			NeedsRewrap:   membership.NeedsRewrap,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, body)
}

func millis(at interface{ UnixMilli() int64 }) int64 {
	return at.UnixMilli()
}
