# mimoza-relay

Go relay server. Architecture and protocol design live in `docs/` at the
repo root: `docs/RELAY_DESIGN.md` for what the relay stores and what its
routes promise, `docs/SYNC_DESIGN.md` for how a device keeps in step with
it.

## Layout: one package per entity

`internal/` is organized by entity, not by layer. Each entity owns its
whole stack: domain types and interfaces at the package root, and below
it one subpackage per capability (its routes, service and store together)
and one adapter subpackage per backing technology (`dynamo/`, `s3/`):

- `circles/` is the relay's model of a circle: who is in it, the role each
  member holds, the content key sealed to each of them, and the entries
  they write. The root holds the shared types, errors and the mapping
  from an error to a status. The capabilities are `circle/`, `members/`,
  `invites/`, `requests/` (asking to join and being let in), `posts/`,
  `comments/` and `reactions/`, plus `erase/` (taking one account out of
  every circle) and `dynamo/`, the one table they share, with a partition
  per circle.
- `accounts/` is who is using the relay: the profile, the devices push
  reaches, device linking and account deletion, each its own subpackage.
- `auth/` is sessions, OIDC verification, and one HTTP subpackage per
  sign-in provider under `auth/http/`.
- `blobs/` is what every entity shares about the bucket (`s3/`, `cdn/`).
- `push/` is mobile push: routing prefs, fanout, and platform dispatch
  (`apns/`, `fcm/`).
- `ratelimit/` is the per-account request budget.

`internal/app/` is the composition root, the one place that imports every
entity: `router.go` wires stores into services and aggregates the routes,
`app.go` builds the real AWS-backed adapters that fill that wiring, and the
package's test suite drives the assembled router end to end.
`internal/util/httputil`, `internal/util/dynamoutil`, `internal/util/ids`,
`internal/config`, `internal/util/localstack`, and `internal/util/testsupport`
are cross-cutting plumbing shared by every entity, not owned by any one of
them. Don't move them into an entity, and don't add a new cross-cutting
package without a real reason more than one entity needs it.

When adding a capability to an existing entity, add a subpackage under it
and keep the domain types at its root. When adding a genuinely new entity,
give it its own package rather than folding it into an existing one.
`circles` earned its size because membership, keys and entries are one
aggregate that changes in single transactions; don't let a second package
grow that way by accident.

## Testing

Two legs, split by whether a package lives under `integration/`:

```bash
go test -race $(go list ./... | grep -Ev '^mimoza-relay/integration(/|$)')  # unit
go test -race ./integration/...                                            # integration, black-box HTTP
```

Both need LocalStack (DynamoDB, S3 and SSM) reachable at
`localhost:4566` — see `internal/util/localstack` and
`internal/util/testsupport`. Without it, tests skip rather than fail; set
`REQUIRE_LOCALSTACK=1` (what CI does) to make a missing LocalStack a hard
failure instead of a silent green run.

Before pushing, also run what CI checks as a separate `build` job:

```bash
go build ./...
go vet ./...
gofmt -l .          # must print nothing
go mod tidy && git diff --exit-code go.mod go.sum   # must be a no-op
```

`go mod tidy` runs *before* `go build` in CI specifically because an
untidy `go.mod` fails the build step with a message that reads as a
broken build rather than a dependency-hygiene issue — a warm local module
cache can hide this on a machine that's built the tree before.

## Storage interfaces: what they're actually for

Every store in this tree is a Go interface where it is used (in the circle
slices, an unexported `store` interface in each `service.go`), backed by
exactly one implementation (`dynamo/` or `s3/`). There has never been a
second backend for any of them. Don't read that as portability: it hasn't
paid for that. Keep it because it is what let the slices, `push` and
`ratelimit` grow real test fakes (`requests/service_test.go`,
`push/service_test.go`, `ratelimit/middleware_test.go`) instead of every
test needing a LocalStack container. Don't add a fake for a store that
doesn't need one just because the interface exists.
