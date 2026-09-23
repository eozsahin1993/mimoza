package app

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
	blobstore "mimoza-relay/internal/blobs/s3"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/circles/comments"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/circles/erase"
	circleinvites "mimoza-relay/internal/circles/invites"
	"mimoza-relay/internal/circles/members"
	"mimoza-relay/internal/circles/posts"
	"mimoza-relay/internal/circles/reactions"
	"mimoza-relay/internal/circles/requests"
	"mimoza-relay/internal/push"
	"mimoza-relay/internal/ratelimit"
	"mimoza-relay/internal/util/httputil"
)

// Deps is everything the router wires into its endpoints. Named fields
// rather than positional: two ratelimit.Store and two *oidcverify.Verifier
// means a read budget could stand in for a write one with nothing to
// catch it.
type Deps struct {
	// Accounts and Circles are the tables each slice in that column builds
	// its own store on — the slices share key shapes and the few reads
	// other columns need, not a store type.
	Accounts *accountsdynamo.Table
	Circles  *dynamo.Table
	// InviteRetention is how long a code, and an unanswered request under
	// it, lasts.
	InviteRetention time.Duration
	// Blobs is the bucket the encrypted photos live in. The relay never
	// carries the bytes: it signs a URL and the device talks to S3 or
	// the CDN directly.
	Blobs *blobstore.Store
	Auth  auth.Store
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
	// Send delivers one notification to one device, or is nil where an
	// environment has no push credentials.
	Send push.Sender
}

func NewRouter(deps Deps) *http.ServeMux {
	mux := http.NewServeMux()
	// Logging wraps the inner mux, not this one: the route pattern is set
	// by whichever mux matched, and StripPrefix hands the inner one its own
	// copy of the request — from out here every route would read "/v1/".
	mux.Handle("/v1/", httputil.WithRequestID(http.StripPrefix("/v1", httputil.LogRequests(newV1Mux(deps)))))
	return mux
}

func newV1Mux(deps Deps) *http.ServeMux {
	mux := http.NewServeMux()

	writeLimit := func(h http.Handler) http.Handler { return ratelimit.Require(deps.WriteLimit, h) }
	readLimit := func(h http.Handler) http.Handler { return ratelimit.Require(deps.ReadLimit, h) }

	// One sub-mux so RequireSession wraps every circles slice at once,
	// while the budget wraps each handler individually — reads and writes
	// don't share one. Each endpoint still checks its own write token or
	// authority signature beyond the session.
	// One notifier for every slice that writes: it resolves who should
	// hear about a change and tells their phones.
	notifier := &push.Notifier{
		Circles:  members.NewStore(deps.Circles),
		Accounts: deps.Accounts,
		Send:     deps.Send,
	}

	circlesMux := http.NewServeMux()
	// Shared, because leaving as the last member ends the circle, and
	// the sweep that does it lives here.
	circleService := &circle.Service{
		Store:    circle.NewStore(deps.Circles),
		Blobs:    deps.Blobs,
		Requests: requests.NewStore(deps.Circles),
	}
	circle.Register(circlesMux, circleService, readLimit, writeLimit)
	members.Register(circlesMux, &members.Service{
		Store:    members.NewStore(deps.Circles),
		Profiles: deps.Accounts,
		Blobs:    deps.Blobs,
		Notify:   notifier,
		Circles:  circleService,
	}, readLimit, writeLimit)
	posts.Register(circlesMux, &posts.Service{
		Store:  posts.NewStore(deps.Circles),
		Blobs:  deps.Blobs,
		Notify: notifier,
	}, readLimit, writeLimit)
	comments.Register(circlesMux, &comments.Service{
		Store:  comments.NewStore(deps.Circles),
		Notify: notifier,
	}, writeLimit)
	reactions.Register(circlesMux, &reactions.Service{
		Store:  reactions.NewStore(deps.Circles),
		Notify: notifier,
	}, writeLimit)
	circleinvites.Register(circlesMux, &circleinvites.Service{
		Store:     circleinvites.NewStore(deps.Circles),
		Retention: deps.InviteRetention,
		Profiles:  deps.Accounts,
	}, readLimit, writeLimit)
	requests.Register(circlesMux, &requests.Service{
		Store:     requests.NewStore(deps.Circles),
		Profiles:  deps.Accounts,
		Retention: deps.InviteRetention,
		Notify:    notifier,
	}, readLimit, writeLimit)
	mux.Handle("/circles", auth.RequireSession(deps.Auth, httputil.LogRoutes(circlesMux)))
	mux.Handle("/circles/", auth.RequireSession(deps.Auth, httputil.LogRoutes(circlesMux)))
	mux.Handle("/invites/", auth.RequireSession(deps.Auth, httputil.LogRoutes(circlesMux)))

	accountMux := http.NewServeMux()
	profile.Register(accountMux, &profile.Service{
		Store:   profile.NewStore(deps.Accounts),
		Circles: members.NewStore(deps.Circles),
		Notify:  notifier,
	}, readLimit, writeLimit)
	devices.Register(accountMux, &devices.Service{Store: devices.NewStore(deps.Accounts)}, writeLimit)
	mux.Handle("/account", auth.RequireSession(deps.Auth, httputil.LogRoutes(accountMux)))
	mux.Handle("/account/", auth.RequireSession(deps.Auth, httputil.LogRoutes(accountMux)))

	deleteAccountService := &deletion.Service{
		AuthStore: deps.Auth,
		Store:     deletion.NewStore(deps.Accounts),
		Circles:   erase.NewStore(deps.Circles),
		Blobs:     deps.Blobs,
	}
	if deps.AppleID != nil {
		deleteAccountService.RevokeApple = deps.AppleID.Revoke
	}
	deletion.Register(mux, deleteAccountService, func(h http.Handler) http.Handler {
		return auth.RequireSession(deps.Auth, h)
	})

	google.Register(mux, &google.Service{AuthStore: deps.Auth, Verifier: deps.Google, Accounts: deps.Accounts})
	apple.Register(mux, &apple.Service{AuthStore: deps.Auth, Verifier: deps.Apple, AppleID: deps.AppleID, Accounts: deps.Accounts})
	logout.Register(mux, &logout.Service{AuthStore: deps.Auth})

	return mux
}
