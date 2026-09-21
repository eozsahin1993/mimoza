// Package api is the composition root — the "final router outside" that
// wires shared storage components into each endpoint's own service and
// aggregates every endpoint's route registration into one mux. Called
// once by each cmd/ entry point (cmd/lambda, cmd/server), whichever way
// the app ends up served.
package api

import (
	"net/http"

	"mimoza-relay/internal/account"
	"mimoza-relay/internal/account/http/deleteaccount"
	"mimoza-relay/internal/account/http/manifest"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/auth/appleid"
	"mimoza-relay/internal/auth/http/apple"
	"mimoza-relay/internal/auth/http/google"
	"mimoza-relay/internal/auth/http/logout"
	"mimoza-relay/internal/auth/oidcverify"
	"mimoza-relay/internal/invite"
	invitehttp "mimoza-relay/internal/invite/http"
	"mimoza-relay/internal/push"
	pushhttp "mimoza-relay/internal/push/http"
	"mimoza-relay/internal/ratelimit"
	"mimoza-relay/internal/synclog"
	"mimoza-relay/internal/synclog/http/appendlog"
	"mimoza-relay/internal/synclog/http/changeauthority"
	"mimoza-relay/internal/synclog/http/createlog"
	"mimoza-relay/internal/synclog/http/deleteauthorcontent"
	"mimoza-relay/internal/synclog/http/deleteblob"
	"mimoza-relay/internal/synclog/http/deletecircle"
	"mimoza-relay/internal/synclog/http/deleteentry"
	"mimoza-relay/internal/synclog/http/getblob"
	"mimoza-relay/internal/synclog/http/getcoverphotouploadtarget"
	"mimoza-relay/internal/synclog/http/getepochs"
	"mimoza-relay/internal/synclog/http/getlog"
	"mimoza-relay/internal/synclog/http/getuploadtarget"
	"mimoza-relay/internal/synclog/http/rotatelog"
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
	Log      synclog.LogStore
	Blob     synclog.BlobStore
	Auth     auth.Store
	Manifest account.Store
	Invite   invite.Store
	// Writes and reads carry different budgets — see internal/ratelimit.
	WriteLimit ratelimit.Store
	ReadLimit  ratelimit.Store
	Google     *oidcverify.Verifier
	Apple      *oidcverify.Verifier
	// AppleID and AppleCredentials are nil unless this environment has a
	// Sign in with Apple key configured — see appleid.NewClient. Without
	// them, sign-in and deletion both still work; deletion just can't
	// revoke the Apple grant behind the account (Guideline 5.1.1(v)).
	AppleID          *appleid.Client
	AppleCredentials auth.AppleCredentialStore
	Push             PushDeps
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

	// The domain layer wrapping deps.Log — holds the capability checks
	// (signature verification, write-token hashing) LogStore's own
	// methods used to do themselves. See internal/synclog.Service.
	logService := &synclog.Service{Log: deps.Log}

	circleMux := http.NewServeMux()
	createlog.Register(circleMux, &createlog.Service{LogStore: deps.Log}, writeLimit)
	appendlog.Register(circleMux, &appendlog.Service{Log: logService}, writeLimit)
	rotatelog.Register(circleMux, &rotatelog.Service{Log: logService}, writeLimit)
	changeauthority.Register(circleMux, &changeauthority.Service{Log: logService}, writeLimit)
	deletecircle.Register(circleMux, &deletecircle.Service{Log: logService, BlobStore: deps.Blob}, writeLimit)
	getlog.Register(circleMux, &getlog.Service{LogStore: deps.Log}, readLimit)
	getblob.Register(circleMux, &getblob.Service{BlobStore: deps.Blob}, readLimit)
	getuploadtarget.Register(circleMux, &getuploadtarget.Service{BlobStore: deps.Blob, LogStore: deps.Log}, writeLimit)
	deleteblob.Register(circleMux, &deleteblob.Service{BlobStore: deps.Blob, LogStore: deps.Log}, writeLimit)
	deleteentry.Register(circleMux, &deleteentry.Service{Log: logService, BlobStore: deps.Blob}, writeLimit)
	deleteauthorcontent.Register(circleMux, &deleteauthorcontent.Service{Log: logService, BlobStore: deps.Blob}, writeLimit)
	getcoverphotouploadtarget.Register(circleMux, &getcoverphotouploadtarget.Service{BlobStore: deps.Blob, LogStore: deps.Log}, writeLimit)
	mux.Handle("/circles/", auth.RequireSession(deps.Auth, httputil.LogRoutes(circleMux)))

	// Account-scoped, not circle-scoped — its own sub-mux, same
	// RequireSession wrapping as circleMux above.
	accountMux := http.NewServeMux()
	manifest.Register(accountMux, &manifest.Service{ManifestStore: deps.Manifest})
	mux.Handle("/account/", auth.RequireSession(deps.Auth, httputil.LogRoutes(accountMux)))
	deleteAccountService := &deleteaccount.Service{ManifestStore: deps.Manifest, AuthStore: deps.Auth}
	if deps.AppleID != nil {
		deleteAccountService.AppleCredentials = deps.AppleCredentials
		deleteAccountService.RevokeApple = deps.AppleID.Revoke
	}
	deleteaccount.Register(mux, deleteAccountService, func(h http.Handler) http.Handler {
		return auth.RequireSession(deps.Auth, h)
	})

	// Invite-tag-scoped, not circle- or account-scoped — its own sub-mux,
	// same RequireSession wrapping as circleMux/accountMux above. Still
	// requires a session: an unauthenticated caller can't hit any /invites/
	// route, even though the routes themselves don't use the caller's
	// accountID — the relay never learns who's inviting whom, only that
	// some authenticated session is.
	invitesMux := http.NewServeMux()
	invitehttp.Register(invitesMux, &invitehttp.Service{InviteStore: deps.Invite})
	invitesHandler := auth.RequireSession(deps.Auth, httputil.LogRoutes(invitesMux))
	mux.Handle("/invites/", invitesHandler)
	// POST /invites has no trailing slash, and "/invites/" alone would
	// answer it with a redirect, which a client re-sends as a GET.
	mux.Handle("/invites", invitesHandler)

	// Not circle-scoped in the path (it spans however many circles a
	// device is in, in one call) — its own sub-mux rather than nested
	// under circleMux, same RequireSession wrapping as the others above.
	// readLimit for now, same budget as getlog/getblob — worth revisiting
	// once this is actually polled on its intended ~30s cadence.
	epochsMux := http.NewServeMux()
	getepochs.Register(epochsMux, &getepochs.Service{LogStore: deps.Log}, readLimit)
	mux.Handle("/epochs/", auth.RequireSession(deps.Auth, httputil.LogRoutes(epochsMux)))

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

	google.Register(mux, &google.Service{AuthStore: deps.Auth, Verifier: deps.Google})
	apple.Register(mux, &apple.Service{AuthStore: deps.Auth, Verifier: deps.Apple, AppleID: deps.AppleID, Credentials: deps.AppleCredentials})
	logout.Register(mux, &logout.Service{AuthStore: deps.Auth})

	return mux
}
