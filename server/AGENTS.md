# mimoza-relay

Go relay server. Architecture and protocol design live in `docs/` at the
repo root — read `docs/SYNC_DESIGN.md` before touching anything under
`internal/synclog/`.

## Layout: one column per entity

`internal/` is organized by entity, not by layer. Each column owns its
whole stack — domain types and interfaces at the column root, the
HTTP-facing slice in `http/` (one subpackage per endpoint, each with its
own `handler.go`/`router.go`/`service.go`), and one adapter subpackage per
backing technology (`dynamodb/`, `s3/`):

- `synclog/` — the append-only per-circle log and the blobs behind its
  entries (one aggregate: a blob is gated by the same write token and
  swept on the same circle deletion as the log). `LogStore` and
  `BlobStore` are the two storage interfaces at the root.
- `auth/` — sessions, OIDC verification, and the `google`/`apple`/`logout`
  sign-in providers under `auth/http/`.
- `account/` — the per-account encrypted manifest, plus account deletion.
- `invite/` — the invite/join-request flow.
- `push/` — mobile push: routing prefs, fanout, and platform dispatch
  (`apns/`, `fcm/`).
- `ratelimit/` — the per-account request budget.

`internal/app/` is the composition root — the one place that imports every
column: `router.go` wires stores into services and aggregates the routes,
`app.go` builds the real AWS-backed adapters that fill that wiring, and the
package's test suite drives the assembled router end to end.
`internal/util/httputil`, `internal/util/dynamoutil`, `internal/config`,
`internal/util/localstack`, and `internal/util/testsupport` are cross-cutting
plumbing shared by every column, not owned by any one of them — don't
move them into a column, and don't add a new cross-cutting package
without a real reason more than one column needs it.

When adding a capability to an existing entity, it belongs inside that
column (domain logic at the root, wire concerns under `http/`). When
adding a genuinely new entity, give it its own column rather than folding
it into an existing one — `synclog` earned its size because the sync
log's capability model (write tokens, authority set, signed messages,
tombstones) has nowhere else to live; don't let that happen to a second
column by accident.

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

Every store in this tree is a Go interface at its column's root, backed
by exactly one implementation (`dynamodb/` or `s3/`) — there has never
been a second backend for any of them. Don't read that as portability:
it hasn't paid for that. Keep it because it (a) is where `synclog`'s
`LogStore`/`BlobStore` contracts are written down independent of AWS, and
(b) is what let `push` and `ratelimit` grow real test fakes
(`push/service_test.go`, `ratelimit/middleware_test.go`) instead of every
test needing a LocalStack container. Don't add a fake for a store that
doesn't need one just because the interface exists.
