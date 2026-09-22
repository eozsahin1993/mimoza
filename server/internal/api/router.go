// Package api is the composition root — the "final router outside" that
// wires shared storage components into each endpoint's own service and
// aggregates every endpoint's route registration into one mux. Called
// once by each cmd/ entry point (cmd/lambda, cmd/server), whichever way
// the app ends up served.
package api

import (
	"net/http"
	"time"

	"mimoza-relay/internal/accounts/deletion"
	"mimoza-relay/internal/accounts/devices"
	accountsdynamo "mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/accounts/profile"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/auth/appleid"
	"mimoza-relay/internal/auth/http/apple"
	"mimoza-relay/internal/auth/http/google"
	"mimoza-relay/internal/auth/http/logout"
	"mimoza-relay/internal/auth/oidcverify"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/circles/comments"
	"mimoza-relay/internal/circles/dynamo"
	circleinvites "mimoza-relay/internal/circles/invites"
	"mimoza-relay/internal/circles/members"
	"mimoza-relay/internal/circles/posts"
	"mimoza-relay/internal/circles/reactions"
	"mimoza-relay/internal/circles/requests"
	"mimoza-relay/internal/invite"
	"mimoza-relay/internal/push"
	pushhttp "mimoza-relay/internal/push/http"
	"mimoza-relay/internal/ratelimit"
	"mimoza-relay/internal/synclog"
	"mimoza-relay/internal/util/httputil"
)

// PushDeps groups the push slice's dependencies. A struct because
// NewRouter already takes two ratelimit.Store values, and a third
// positional one would be easy to pass in the wrong order silently.
type PushDeps struct {
	Store          push.Store
	RecipientLimit ratelimit.Store
	// Nil until the platform credentials exist: fanout still resolves and
	// reports, it just drops the deliveries.
	Dispatch func(push.Delivery, int64, []byte)
}

// Deps is everything the router wires into its endpoints, named rather
// than positional — four fields share two types (two ratelimit.Store,
// two *oidcverify.Verifier), so a positional list let a read budget stand
// in for a write one with nothing to catch it. PushDeps was already a
// struct for the same reason; this finishes the job.
type Deps struct {
	// Accounts is the table every accounts slice builds its own store
	// on, the same way Circles is: the slices share key shapes and the
	// two reads other columns need, not a store type.
	Accounts *accountsdynamo.Table
	// Circles is the table every circles slice builds its own store on;
	// the slices share key shapes and a few reads, not a store type.
	Circles *dynamo.Table
	// InviteRetention is how long a code, and an unanswered request under
	// it, lasts.
	InviteRetention time.Duration
	Log             synclog.LogStore
	Blob            synclog.BlobStore
	Auth            auth.Store
	Invite          invite.Store
	// Writes and reads carry different budgets — see internal/ratelimit.
	WriteLimit ratelimit.Store
	ReadLimit  ratelimit.Store
	Google     *oidcverify.Verifier
	Apple      *oidcverify.Verifier
	// AppleID is nil unless this environment has a Sign in with Apple key
	// configured — see appleid.NewClient. Without it, sign-in and
	// deletion both still work; deletion just cannot revoke the grant
	// behind an Apple account (Guideline 5.1.1(v)).
	AppleID *appleid.Client
	Push    PushDeps
}

func NewRouter(deps Deps) *http.ServeMux {
	mux := http.NewServeMux()
	// Logging wraps the inner mux, not this one: the route pattern is set
	// by whichever mux matched, and StripPrefix hands the inner one its own
	// copy of the request — from out here every route would read "/v1/".
	mux.Handle("/v1/", http.StripPrefix("/v1", httputil.LogRequests(newV1Mux(deps))))
	return mux
}

// newV1Mux is the only version that exists today. When a v2 is needed, add
// a sibling newV2Mux and mount it at "/v2/" alongside this one — existing
// clients keep hitting "/v1/" unchanged, and each endpoint's own Register
// stays unaware that versioning exists at all.
func newV1Mux(deps Deps) *http.ServeMux {
	mux := http.NewServeMux()

	// Grouped under one sub-mux so RequireSession wraps all eight at once —
	// each endpoint also checks its own write token/authority signature
	// beyond this shared session check. Rate limiting wraps each handler
	// individually instead of circleMux as a whole, since writes and reads
	// carry different budgets (see internal/ratelimit).
	writeLimit := func(h http.Handler) http.Handler { return ratelimit.Require(deps.WriteLimit, h) }
	readLimit := func(h http.Handler) http.Handler { return ratelimit.Require(deps.ReadLimit, h) }

	// The relay-owned circles, one slice per resource. Each registers
	// its own routes and carries the read or write budget that route
	// needs; the session check wraps all of them at once.
	circlesMux := http.NewServeMux()
	circle.Register(circlesMux, &circle.Service{Store: circle.NewStore(deps.Circles)}, readLimit, writeLimit)
	members.Register(circlesMux, &members.Service{Store: members.NewStore(deps.Circles)}, readLimit, writeLimit)
	posts.Register(circlesMux, &posts.Service{Store: posts.NewStore(deps.Circles)}, readLimit, writeLimit)
	comments.Register(circlesMux, &comments.Service{Store: comments.NewStore(deps.Circles)}, writeLimit)
	reactions.Register(circlesMux, &reactions.Service{Store: reactions.NewStore(deps.Circles)}, writeLimit)
	circleinvites.Register(circlesMux, &circleinvites.Service{
		Store:     circleinvites.NewStore(deps.Circles),
		Retention: deps.InviteRetention,
	}, readLimit, writeLimit)
	requests.Register(circlesMux, &requests.Service{
		Store:     requests.NewStore(deps.Circles),
		Retention: deps.InviteRetention,
	}, readLimit, writeLimit)
	mux.Handle("/circles", auth.RequireSession(deps.Auth, httputil.LogRoutes(circlesMux)))
	mux.Handle("/circles/", auth.RequireSession(deps.Auth, httputil.LogRoutes(circlesMux)))
	mux.Handle("/invites/", auth.RequireSession(deps.Auth, httputil.LogRoutes(circlesMux)))

	// The account itself: its profile, its public key, its devices.
	accountMux := http.NewServeMux()
	profile.Register(accountMux, &profile.Service{
		Store:   profile.NewStore(deps.Accounts),
		Circles: members.NewStore(deps.Circles),
	}, readLimit, writeLimit)
	devices.Register(accountMux, &devices.Service{Store: devices.NewStore(deps.Accounts)}, writeLimit)
	mux.Handle("/account", auth.RequireSession(deps.Auth, httputil.LogRoutes(accountMux)))
	mux.Handle("/account/", auth.RequireSession(deps.Auth, httputil.LogRoutes(accountMux)))

	deleteAccountService := &deletion.Service{AuthStore: deps.Auth, Store: deletion.NewStore(deps.Accounts)}
	if deps.AppleID != nil {
		deleteAccountService.RevokeApple = deps.AppleID.Revoke
	}
	deletion.Register(mux, deleteAccountService, func(h http.Handler) http.Handler {
		return auth.RequireSession(deps.Auth, h)
	})

	// Registration is session-gated; the send route is not, and mounts on
	// the parent mux — see pushhttp.FanoutHandler. "POST /push/send" is more
	// specific than "/push/" so it wins the match; changing either pattern
	// risks silently authenticating the one route that must not be.
	if deps.Push.Store != nil {
		pushService := &push.Service{PushStore: deps.Push.Store, RecipientLimit: deps.Push.RecipientLimit}

		pushMux := http.NewServeMux()
		pushhttp.Register(pushMux, pushService)
		mux.Handle("/push/", auth.RequireSession(deps.Auth, httputil.LogRoutes(pushMux)))

		dispatch := deps.Push.Dispatch
		if dispatch == nil {
			dispatch = func(push.Delivery, int64, []byte) {}
		}
		pushhttp.RegisterFanout(mux, &pushhttp.FanoutHandler{Service: pushService, Dispatch: dispatch})
	}

	google.Register(mux, &google.Service{AuthStore: deps.Auth, Verifier: deps.Google, Accounts: deps.Accounts})
	apple.Register(mux, &apple.Service{AuthStore: deps.Auth, Verifier: deps.Apple, AppleID: deps.AppleID, Accounts: deps.Accounts})
	logout.Register(mux, &logout.Service{AuthStore: deps.Auth})

	return mux
}
