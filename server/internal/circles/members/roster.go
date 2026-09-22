package members

import (
	"encoding/base64"
	"net/http"
	"strconv"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type memberResponse struct {
	AccountID   string `json:"accountId"`
	Role        string `json:"role"`
	NotifyLevel string `json:"notifyLevel"`
	NeedsRewrap bool   `json:"needsRewrap,omitempty"`
	JoinedAt    int64  `json:"joinedAt"`
}

type rosterResponse struct {
	RosterVersion int64             `json:"rosterVersion"`
	KeyVersion    int64             `json:"keyVersion"`
	Members       []memberResponse  `json:"members"`
	Keys          map[string]string `json:"keys"`
}

type RosterHandler struct {
	Service *Service
}

func (h *RosterHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	circle, roster, keys, err := h.Service.Roster(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	body := rosterResponse{
		RosterVersion: circle.RosterVersion,
		KeyVersion:    circle.KeyVersion,
		Members:       make([]memberResponse, 0, len(roster)),
		Keys:          make(map[string]string, len(keys)),
	}
	for _, member := range roster {
		body.Members = append(body.Members, memberResponse{
			AccountID:   member.AccountID,
			Role:        member.Role,
			NotifyLevel: member.NotifyLevel,
			NeedsRewrap: member.NeedsRewrap,
			JoinedAt:    member.JoinedAt.UnixMilli(),
		})
	}
	// Keyed by version as a string: JSON object keys are strings, and the
	// device looks its own version up rather than scanning a list.
	for version, sealed := range keys {
		body.Keys[strconv.FormatInt(version, 10)] = base64.StdEncoding.EncodeToString(sealed)
	}
	httputil.WriteJSON(w, http.StatusOK, body)
}

// sealedFrom decodes a version-to-base64 map, the shape every key
// handoff in this slice takes.
func sealedFrom(raw map[string]string) (circles.SealedKeys, error) {
	keys := make(circles.SealedKeys, len(raw))
	for version, encoded := range raw {
		parsed, err := strconv.ParseInt(version, 10, 64)
		if err != nil {
			return nil, err
		}
		sealed, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, err
		}
		keys[parsed] = sealed
	}
	return keys, nil
}
