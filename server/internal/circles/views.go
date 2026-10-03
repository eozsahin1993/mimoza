package circles

// Views: the shape a circle's things take on the way out, and the status
// a failure takes with them. They live beside the domain types every
// slice already imports, so a slice needs one import rather than two,
// and a post looks the same whether it comes from a walk or from the
// write that created it. Request bodies are not here: each belongs to
// the one handler that parses it.

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"mimoza-relay/internal/blobs"
	"mimoza-relay/internal/util/httputil"
	"net/http"
	"time"
)

type EntryView struct {
	EntryID    string `json:"entryId"`
	Type       string `json:"type"`
	AuthorID   string `json:"authorId"`
	ReceivedAt int64  `json:"receivedAt"`

	KeyVersion     int64            `json:"keyVersion,omitempty"`
	Ciphertext     string           `json:"ciphertext,omitempty"`
	HasBlob        bool             `json:"hasBlob,omitempty"`
	Visibility     string           `json:"visibility,omitempty"`
	CommentCount   int64            `json:"commentCount,omitempty"`
	ReactionCounts map[string]int64 `json:"reactionCounts,omitempty"`
	RecentComments []CommentView    `json:"recentComments,omitempty"`
	// IReacted and ICommented are what a card shows about you, without a
	// second call. Which emoji you picked comes from the children fetch
	// when the post is opened, since the wall only shows a filled state.
	IReacted   bool  `json:"iReacted,omitempty"`
	ICommented bool  `json:"iCommented,omitempty"`
	UpdatedAt  int64 `json:"updatedAt,omitempty"`
	DeletedAt  int64 `json:"deletedAt,omitempty"`

	Event       string `json:"event,omitempty"`
	SubjectID   string `json:"subjectId,omitempty"`
	SubjectName string `json:"subjectName,omitempty"`
}

type CommentView struct {
	CommentID       string `json:"commentId"`
	AuthorID        string `json:"authorId"`
	ParentCommentID string `json:"parentCommentId,omitempty"`
	KeyVersion      int64  `json:"keyVersion"`
	Ciphertext      string `json:"ciphertext,omitempty"`
	ReceivedAt      int64  `json:"receivedAt"`
	DeletedAt       int64  `json:"deletedAt,omitempty"`
}

type ReactionView struct {
	AccountID  string `json:"accountId"`
	Tag        string `json:"tag"`
	KeyVersion int64  `json:"keyVersion"`
	Ciphertext string `json:"ciphertext,omitempty"`
	ReceivedAt int64  `json:"receivedAt"`
}

func FromEntry(entry Entry) EntryView {
	out := EntryView{
		EntryID:    entry.ID,
		Type:       entry.Type,
		AuthorID:   entry.AuthorID,
		ReceivedAt: entry.ReceivedAt.UnixMilli(),
	}
	if entry.Type == TypeActivity {
		out.Event = entry.Event
		out.SubjectID = entry.SubjectID
		out.SubjectName = entry.SubjectName
		return out
	}

	out.KeyVersion = entry.KeyVersion
	out.Ciphertext = base64.StdEncoding.EncodeToString(entry.Ciphertext)
	out.HasBlob = entry.HasBlob
	out.Visibility = entry.Visibility
	out.CommentCount = entry.CommentCount
	out.ReactionCounts = entry.ReactionCounts
	out.UpdatedAt = entry.UpdatedAt.UnixMilli()
	out.DeletedAt = millis(entry.DeletedAt)
	for _, comment := range entry.RecentComments {
		out.RecentComments = append(out.RecentComments, FromComment(comment))
	}
	out.IReacted = entry.IReacted
	out.ICommented = entry.ICommented
	return out
}

func FromComment(comment Comment) CommentView {
	return CommentView{
		CommentID:       comment.ID,
		AuthorID:        comment.AuthorID,
		ParentCommentID: comment.ParentCommentID,
		KeyVersion:      comment.KeyVersion,
		Ciphertext:      base64.StdEncoding.EncodeToString(comment.Ciphertext),
		ReceivedAt:      comment.ReceivedAt.UnixMilli(),
		DeletedAt:       millis(comment.DeletedAt),
	}
}

func FromReaction(reaction Reaction) ReactionView {
	return ReactionView{
		AccountID:  reaction.AccountID,
		Tag:        reaction.Tag,
		KeyVersion: reaction.KeyVersion,
		Ciphertext: base64.StdEncoding.EncodeToString(reaction.Ciphertext),
		ReceivedAt: reaction.ReceivedAt.UnixMilli(),
	}
}

// millis leaves an absent time absent, rather than sending the epoch.
func millis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// Status maps a domain error onto the response a client gets. Anything
// unmapped is a 500: a new error should surface as a bug, not as a
// plausible-looking 400.
func Status(err error) (int, string) {
	switch {
	case errors.Is(err, ErrCircleNotFound), errors.Is(err, ErrEntryNotFound),
		errors.Is(err, ErrInviteNotFound), errors.Is(err, ErrRequestNotFound),
		errors.Is(err, ErrPictureNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, ErrNotMember), errors.Is(err, ErrNotAdmin),
		errors.Is(err, ErrNotTheAuthor):
		return http.StatusForbidden, err.Error()
	case errors.Is(err, ErrAlreadyExists), errors.Is(err, blobs.ErrExists),
		errors.Is(err, ErrCircleFull),
		errors.Is(err, ErrStaleKeyVersion), errors.Is(err, ErrVersionMoved),
		errors.Is(err, ErrWouldEmptyAdmins), errors.Is(err, ErrPublicKeyChanged):
		return http.StatusConflict, err.Error()
	case errors.Is(err, ErrBadCursor), errors.Is(err, ErrIncompleteKeys),
		errors.Is(err, ErrNoPublicKey):
		return http.StatusBadRequest, err.Error()
	default:
		// Unmapped means a bug, not a client mistake: say so in the log,
		// where an operator can see it, and say nothing useful to the
		// caller, who cannot act on it.
		slog.Error("unmapped circles error", "reason", "unmapped_error", "error", err)
		return http.StatusInternalServerError, "something went wrong"
	}
}

// codes are the wire names of the errors a client acts on by kind. One
// that is not here still gets a status and message, just no code.
var codes = map[error]string{
	ErrCircleNotFound:   "circle_not_found",
	ErrEntryNotFound:    "entry_not_found",
	ErrInviteNotFound:   "invite_not_found",
	ErrRequestNotFound:  "request_not_found",
	ErrPictureNotFound:  "picture_not_found",
	ErrNotMember:        "not_member",
	ErrNotAdmin:         "not_admin",
	ErrNotTheAuthor:     "not_author",
	ErrAlreadyExists:    "already_exists",
	ErrCircleFull:       "circle_full",
	ErrStaleKeyVersion:  "stale_key_version",
	ErrVersionMoved:     "version_moved",
	ErrWouldEmptyAdmins: "would_empty_admins",
	ErrPublicKeyChanged: "public_key_changed",
	ErrBadCursor:        "bad_cursor",
	ErrIncompleteKeys:   "incomplete_keys",
	ErrNoPublicKey:      "no_public_key",
}

// Code is the wire name for err, or "" if it has none.
func Code(err error) string {
	for sentinel, code := range codes {
		if errors.Is(err, sentinel) {
			return code
		}
	}
	return ""
}

// WriteError answers a failed circles request: status and message from
// Status, the code beside them, and the message on the request's log
// line so a 4xx in CloudWatch says which one it was.
func WriteError(ctx context.Context, w http.ResponseWriter, err error) {
	status, message := Status(err)
	httputil.SetReason(ctx, message)
	if code := Code(err); code != "" {
		httputil.WriteCodedError(w, status, code, message)
		return
	}
	httputil.WriteError(w, status, message)
}
