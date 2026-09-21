# mimoza-relay

The relay server for the Mimoza app — a blind relay for encrypted circle
content, plus account auth/recovery plumbing. It never sees plaintext
content and is designed to infer as little as possible about circle
membership or social structure. See [DESIGN.md](../docs/DESIGN.md) for the
full architecture writeup and the reasoning behind each decision; this
file is just a map to find your way around the code.

## Layout

```
cmd/
  server/     entry point for `go run` / local dev — http.ListenAndServe
  lambda/     entry point for AWS Lambda (behind a Function URL)
  testrelay/  the same relay against LocalStack, for the integration suite
  decryptlog/ developer-only: decrypts a circle's log to a local file
internal/
  api/       router.go alone — the composition root that wires everything together
  synclog/ auth/ account/ invite/ push/ ratelimit/
             one column per entity: domain types and store interface at the
             root, one subpackage per endpoint under http/, one per adapter
             (dynamodb/, s3/, cdn/) — see AGENTS.md
  app/       builds the real AWS-backed adapters every cmd/ entry runs on
  config/    reads every env var once, in one place
  util/      httputil, dynamoutil, localstack, testsupport — cross-cutting
provision/
  modules/   storage, lambda, cdn, certificate, alarms, github-deploy
  envs/      one thin root per environment: local (LocalStack), staging, prod
  bootstrap/ the S3 bucket staging/prod state lives in — applied once per account
```

`cmd/server` and `cmd/lambda` both build their handler with
`internal/app.New`, which calls the same `api.NewRouter(...)` — nothing
below `internal/api` knows or cares whether it's running on Lambda or as a
long-lived process.

## Storage: six tables, six different reasons

- **sync-log** (`internal/synclog`) — one row per circle-log entry, keyed
  by `syncId` + `<namespace>#<epoch>`. Never evicted: entries are retained
  and immutable, and the only rows carrying a TTL are idempotency markers
  and a deleted circle's leftover meta.
- **sessions** (`internal/auth`) — one row per bearer token.
  TTL'd (90 days from issuance). Looked up by token, and by account
  through the `accountId` GSI when deletion revokes every session at once.
- **accounts** (`internal/account`) — one row per account,
  holding a single opaque `blob` the client encrypted itself. Never
  TTL'd. The relay only ever reads/writes ciphertext here — see
  DESIGN.md's "Account recovery" section.
- **invites** (`internal/invite`), **rate-limit** (`internal/ratelimit`),
  **push** (`internal/push`) — the invite/join mailbox (TTL'd,
  `INVITE_RETENTION_DAYS`), the per-account request budget, and push
  routing prefs plus one row per device.

Each table exists because its access pattern and lifecycle genuinely
differ from the others — see each package's own doc comment for the
specific reasoning, and `internal/util/dynamoutil` for the handful of
attribute-encoding helpers they all share.

## Auth flow, end to end

This is the part that trips people up, so it's worth walking through
directly rather than just reading five files in isolation.

1. **Sign-in** (`internal/auth/http/google`, `.../apple`) verifies the
   client's ID token against the provider's own public keys
   (`internal/auth/oidcverify`), then builds an **accountId**:
   `"google:" + sub` or `"apple:" + sub`. `sub` is the OIDC subject claim
   — a permanent, provider-issued identifier, required on every token by
   spec. The `provider:` prefix exists purely so Google's and Apple's
   independently-issued `sub` values can never collide with each other;
   it's not a lookup key for anything server-side.

   Identity is keyed on `sub`, not email, because email can change
   (a person edits their account email, or an Apple private-relay
   address gets regenerated) while `sub` can't — see DESIGN.md's
   "Account recovery" section for the full reasoning.

2. **`auth.Issue`** (`internal/auth/session.go`) mints a random
   bearer token and stores `auth.Session{AccountID: accountID,
   ExpiresAt: ...}` in the sessions table, keyed by that token. The
   token — not the accountID — is what the client gets back and sends on
   every future request. This indirection is what makes a session
   revocable (logout deletes the token's row) without needing to touch
   the account itself.

3. **Every request to a protected route** goes through
   `auth.RequireSession` (`internal/auth/middleware.go`), which pulls
   the bearer token off the `Authorization` header, looks up its session,
   checks `ExpiresAt`, and stashes the account on the request's context:

   ```go
   type contextKey int
   const accountIDKey contextKey = iota
   ```

   `accountIDKey` is just a private, collision-proof key for
   `context.WithValue`, which takes `any` as its key — a plain string
   (`"accountID"`) would risk colliding with some other package's context
   value of the same name; an unexported custom type makes that
   impossible, since no other package can construct one.

4. **The handler** retrieves it with `auth.AccountID(ctx)`, which does the
   lookup and type-asserts it back to a `string` — the same value built
   in step 1 (`"google:<sub>"` etc.).

(If you're reading old code, docs, or a diff and see `DeviceID` — that
was this exact field before a rename; it was never actually
device-specific, just the account identifier under an earlier, more
confusing name from when it was `emailHmac`.)

## Identity model: four things that are easy to conflate

This spans both sides (the relay only ever touches the first one), but it
belongs in one place — the confusing part is exactly how these relate to
*each other*, and that's lost if each piece is documented separately next
to its own code.

| | What it is | Derived from | Who needs it to match |
|---|---|---|---|
| **accountId** | `"google:<sub>"` / `"apple:<sub>"` | Provider's OIDC `sub` claim | The relay, for session lookup. See "Auth flow" above. |
| **masterSeed** | 128 bits of entropy behind the 12-word recovery phrase | Random, generated once at onboarding (`generateSeedPhrase()`) | Nobody but your own devices — never leaves the client, never sent to the relay in any form. |
| **circleId** | A local UUID | `generateUUID()`, freely chosen per circle | Only your own devices, across time (see below) — never other members. |
| **syncId** | The relay-visible address for a circle's log | `generateUUID()` once, by the founder (`createCircle`) | Every member — it's the one thing that *has* to match, and the only one a joiner is told rather than derives. |

The relationship: your circle **identity keypair** is
`deriveCircleIdentity(masterSeed, circleId)` — a pure function of your own
seed and your own private label for the circle. Nobody else ever
recomputes it; they only ever learn your public half by reading it out of
the circle's roster, which syncs like any other content. So `circleId`
only has one real job: staying *stable for your own account across a lost
device*, which is exactly what the account-recovery manifest
(`internal/account`) exists to guarantee — it's a durable,
client-encrypted record of each circle's `circleId`, its `syncId` and its
content keys, so a recovering device reproduces the *same* keypairs the
rest of the circle already recognizes, instead of showing up as an
unrecognized stranger.

**How `circleId` and a circle's keys get paired**: not by any derivation —
`syncId` and the content key are independently random, with no
mathematical relationship to `circleId`. They're linked purely by local
storage: the moment a device has them (generating them, for the founder;
opening the sealed approval, for a joiner), the key map goes to Keychain
under that device's own `circleId` (`saveCircleKeyMap`) and the `syncId`
onto the circle's SQLite row. From then on `circleId` is the lookup key
for both; the content key is what everything cryptographic (the write
token via `deriveWriteToken`, decrypting entries) derives from.

**How you actually fetch a circle's content**: read `syncId` off the
local circle row and the key map out of Keychain — both plain local
reads, no derivation — then `GET
/v1/circles/{syncId}/entries?namespace=&sinceEpoch=`; see `fetchEntries`
(app-side) / `internal/synclog/http/getlog` (this repo). The local
`circleId` never itself talks to the relay, it only ever unlocks what's
stored under it.

**How a joiner gets those in the first place** (join-by-invite — built;
see `docs/INVITE_FLOW.md` and `internal/invite`): the invite code itself
carries no secret, just a lookup tag (`sha256("invite-tag" ||
invite_code)`). The requester generates a one-time keypair and posts a
join request to that tag; the approver seals `{keyMap, syncId,
circleName}` to the requester's one-time public key and posts the
response under the same tag. Only the requester's matching private key
can open it — the relay forwards ciphertext under an opaque tag either
side can compute, never learning what's inside or that the two messages
belong to the same handshake beyond sharing a tag.

## Running locally

The relay runs against LocalStack (DynamoDB, S3, SSM) instead of real AWS.
All commands are from `server/`.

**1. Start LocalStack** (once per machine boot; `docker start localstack`
after the first time):

```
docker run -d --name localstack -p 4566:4566 -e SERVICES=dynamodb,s3,ssm localstack/localstack:4.4.0
```

**2. Provision the tables and bucket** (again whenever `provision/modules`
changes, or after LocalStack's container is recreated):

```
(cd provision/envs/local && terraform init && terraform apply)
```

**3. Create `local.env`** from the example and point it at LocalStack:

```
cp .env.example local.env
```

The example is already a working LocalStack configuration:
`RESOURCE_PREFIX=mimoza-local` (the relay derives every table and bucket
name from it, the same way Terraform names them),
`S3_FORCE_PATH_STYLE=true`, and the LocalStack block
(`AWS_ENDPOINT_URL=http://localhost:4566` and the `test`/`test` keys).
What's missing is the sign-in client IDs and the credential-file lines,
which ship commented out — point `FCM_CREDENTIAL_FILE`,
`APNS_AUTH_KEY_FILE` and, only if you need Apple grant revocation,
`APPLE_SIGNIN_KEY_FILE` at the key files in this directory. `.gitignore`
keeps every `*.env` and every key out of the repo.

**4. Run it with `local.env` loaded.** Go doesn't read env files itself, so export
it into the shell first:

```
set -a; source local.env; set +a
go run ./cmd/server          # logs "listening on :<PORT>"
```

Or in one line, without leaking the vars into your shell:

```
(set -a; source local.env; set +a; go run ./cmd/server)
```

Don't use `export $(cat local.env | xargs)`: bash chokes on the comment lines
(`export: '#': not a valid identifier`), and any value with a space splits.

Set `PORT=8090` (the example ships 8080): a dev build of the app talks to
the relay on the same host as the Metro packager, at
`EXPO_PUBLIC_RELAY_PORT` (default 8090), whenever `EXPO_PUBLIC_RELAY_URL`
is unset or loopback. A non-loopback `EXPO_PUBLIC_RELAY_URL` wins even in
a dev build — a staging build is a dev build too (see
`app/src/core/services/relay.ts`).

Photo uploads and downloads go straight to LocalStack through presigned
URLs, not through the relay. Keep `AWS_ENDPOINT_URL=http://localhost:4566`:
when it's loopback, cmd/server signs each URL for the host the device used to
reach the relay (a LAN IP, or `10.0.2.2` from the Android emulator), so they
work from a phone, emulator or simulator alike.

### Rebuild on change, or you will chase phantom bugs

`go run` builds once and keeps serving that binary, so a route edited
after startup simply isn't there. The symptom is a lie: the path still
matches an old pattern, so Go answers **405 Method Not Allowed** rather
than 404, and it looks like a client bug. This has already cost one
debugging session — a client correctly sending `POST .../upload` against
a binary built ~40 minutes before the route changed from `GET` to `POST`.

Run it under a watcher instead:

```
go install github.com/bokwoon95/wgo@latest      # once
(set -a; source local.env; set +a; wgo run ./cmd/server)
```

`wgo` needs no config file. `air` works too if you already have it.

When a relay call fails with a status that makes no sense against the
code in front of you, **check the server's start time before debugging
the client**:

```
ps -o lstart,command -p $(lsof -ti :8090)
```

**Pin LocalStack to exactly `4.4.0`** (the last version usable without a
LocalStack account/auth token — 2026.03.0 and later require one even for
free-tier services like S3/DynamoDB). Don't drop back to the `3.8` line
either: its S3 provider has a real bug in presigned-POST handling —
even a byte-for-byte correct multipart request against a
`content-length-range` + `Content-Type` policy comes back `AccessDenied`
(confirmed directly, not a client-side issue), and separately its S3
lifecycle-configuration API hangs until Terraform times out. Both are
fixed in `4.4.0`.

`go test ./...` runs against the same LocalStack instance
(`internal/util/testsupport` creates tables lazily on first use, shared
across test packages — see its own doc comment for why IDs in tests are
always freshly generated, never hardcoded). Without LocalStack those
tests skip; `AGENTS.md` has the two legs CI runs and how to make a
missing LocalStack fail instead.

## Deploying (staging, prod)

Each env is its own AWS account, and `provision/envs/<env>` wires the same
modules together. All names come from the prefix `mimoza-<env>` — Terraform
creates resources under it, and the Lambda gets it as `RESOURCE_PREFIX` and
derives the rest. See `docs/INFRASTRUCTURE.md` for the accounts, domains and
what lives where.

Once per AWS account, create the bucket Terraform state lives in (copy
`bootstrap/bootstrap.auto.tfvars.example` first), then copy
`envs/<env>/<env>.auto.tfvars.example` and fill it in — account id, domain
and alert address:

```
(cd provision/bootstrap && terraform init && terraform apply)
```

Settings reach a deployed relay three ways, and only the first needs a file
on your machine:

- **`server/<env>.env`** — the sign-in client IDs and the Apple/APNs
  identifiers, plus `FCM_CREDENTIAL_FILE`/`APNS_AUTH_KEY_FILE`/
  `APPLE_SIGNIN_KEY_FILE` pointing at the key files. `push-config.sh`
  uploads the settings to `/mimoza-<env>/config/` and those three keys as
  SecureStrings. Re-run it whenever the file changes:

  ```
  provision/push-config.sh staging
  ```

- **`envs/<env>/main.tf`'s `settings`** — tuning (blob size cap, invite
  retention, rate limits), applied by `terraform apply` alone.
- **SSM, written by Terraform** — the blob CDN's own settings, which the relay
  reads at runtime because the Lambda can't be told them directly.

Deploying itself is CI's job (`.github/workflows/server-deploy.yml`):
staging applies on every `main` push whose Server Tests run passed, prod
only on a `server-v*` tag, and `workflow_dispatch` re-runs staging by
hand. Each job runs `provision/build.sh` and then `terraform apply` in
`envs/<env>`, with the account id, domain, alert email and repository
passed as `TF_VAR_*` from that GitHub Environment rather than a `.tfvars`
file — a pre-apply step fails the job if any of them is empty.

Applying from your own machine — and reading an env's outputs — is the
same sequence:

```
provision/build.sh
(cd provision/envs/staging && terraform init && terraform apply)
(cd provision/envs/staging && terraform output api_endpoint)   # the app build's EXPO_PUBLIC_RELAY_URL
(cd provision/envs/staging && terraform output dns_records)    # CNAMEs to add at Cloudflare
```

`terraform apply` needs credentials Terraform understands: an access-key
profile, or `eval "$(aws configure export-credentials --profile <p> --format env)"`
if that profile came from `aws login`, which only the AWS CLI can read.
