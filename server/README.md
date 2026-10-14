# mimoza-relay

The relay server for the Mimoza app — a blind relay for encrypted circle
content, plus the accounts, sessions and push around it. It never sees
plaintext content. See [docs/RELAY_DESIGN.md](../docs/RELAY_DESIGN.md)
for what it stores and what each route promises, and
[docs/SYNC_DESIGN.md](../docs/SYNC_DESIGN.md) for how a device keeps in
step with it; this file is just a map to find your way around the code.

## Layout

```
cmd/
  server/     entry point for `go run` / local dev — http.ListenAndServe
  lambda/     entry point for AWS Lambda (behind a Function URL)
  testrelay/  the same relay against LocalStack, for the app's integration suite
internal/
  accounts/ auth/ blobs/ circles/ feedback/ push/ ratelimit/
             one package per entity: domain types at the root, one
             subpackage per capability (its routes, service and store
             together), one per adapter (dynamo/, s3/, ses/) — see AGENTS.md
  app/       the composition root: router.go wires stores into services and
             aggregates every route; app.go builds the real AWS adapters
  config/    reads every env var once, in one place
  util/      httputil, dynamoutil, ids, localstack, testsupport — cross-cutting
provision/
  modules/   storage, lambda, cdn, certificate, alarms, email, github-deploy
  envs/      one thin root per environment: local (LocalStack), staging, prod
  bootstrap/ the S3 bucket staging/prod state lives in — applied once per account
```

`cmd/server` and `cmd/lambda` both build their handler with
`internal/app.New`, which calls the same `app.NewRouter(...)` — nothing
below `internal/app` knows or cares whether it's running on Lambda or as a
long-lived process.

## Storage: four tables and a bucket

- **circles** (`internal/circles/dynamo`) — one partition per circle:
  its meta, members, sealed content keys, invites, join requests, posts,
  comments and reactions. The one table that changes in transactions,
  which is why membership, keys and entries share a package.
- **accounts** (`internal/accounts/dynamo`) — one partition per account:
  profile, devices push reaches, linked sign-ins and device-link
  handoffs, plus a tiny partition per sign-in that points at its account.
- **sessions** (`internal/auth/dynamodb`) — one row per bearer token,
  TTL'd 90 days, with an `accountId` index so deletion can revoke them all.
- **rate-limit** (`internal/ratelimit/dynamodb`) — one fixed-window
  budget per account and kind (write, read, feedback).
- **blobs** (S3, `internal/blobs/s3`) — photo and cover ciphertext, and
  plain profile pictures. The relay only ever signs URLs for it.

Feedback from the app (`internal/feedback`) is the one thing with no
table: it is emailed through SES and nothing is kept.
`docs/RELAY_DESIGN.md` has the key shapes of every table.

## Auth flow, end to end

This is the part that trips people up, so it's worth walking through
directly rather than just reading five files in isolation.

1. **Sign-in** (`internal/auth/http/google`, `.../apple`) verifies the
   client's ID token against the provider's own public keys
   (`internal/auth/oidcverify`), then resolves the provider and its
   `sub` claim to an **accountId** through the accounts table
   (`accounts/dynamo/identity.go`): a `provider#<name>:<sub>` lookup row
   points at the account, and a first sign-in mints a fresh random id
   and writes both in one transaction, so two racing first sign-ins
   yield one account. `sub` is the OIDC subject, permanent and
   provider-issued; the relay keys on it rather than email, which can
   change, and keeps no email at all.

   The account id is the relay's own, so a second sign-in method can be
   linked to the same account later without anything keyed on the id
   changing.

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
   lookup and type-asserts it back to a `string` — the same id resolved
   in step 1.

## Identity, keys and what the relay can see

Two ids the relay mints, and one key it never holds the private half of:

| | What it is | Who needs it |
|---|---|---|
| **accountId** | Random, minted by the relay at first sign-in; a provider `sub` is a lookup onto it | The relay, for sessions, rosters and push |
| **circleId** | Random, minted by the relay when a circle is created; its partition key | Every member, and the relay — it is the address of everything in the circle |
| **account keypair** | X25519, per account; the public half is on the profile, the private half stays in the device's synced keychain | Members, to seal a circle's content key to you |

Content keys are sealed to each member's public key and stored beside
the membership; the relay holds ciphertext it cannot open, and a member
reseals for someone whose key changed. The whole of this — the trust
model, what is and is not encrypted, joining, a new device, deletion —
is in `docs/RELAY_DESIGN.md`, which is the source of truth; nothing here
should be read as a second description of it.

## Running locally

The relay runs against LocalStack (DynamoDB, S3, SSM, SES) instead of real AWS.
All commands are from `server/`.

**1. Start LocalStack and provision its tables:**

```
provision/local-setup.sh
```

Re-run it any time LocalStack looks wrong — a missing table
(`ResourceNotFoundException: Cannot do operations on a non-existent
table`), `provision/modules` having changed, or LocalStack having lost
its state across a machine restart. It always removes and recreates the
`localstack` container: there's nothing local dev needs preserved across
a reset, and it's a more reliable fix than guessing at what's stale.

That one command is exactly these two steps, run separately if you want
to see each on its own:

```
docker run -d --name localstack -p 4566:4566 -e SERVICES=dynamodb,s3,ssm,ses localstack/localstack:4.4.0
(cd provision/envs/local && terraform init && terraform apply)
```

**2. Create `local.env`** from the example and point it at LocalStack:

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

**3. Run it with `local.env` loaded.** Go doesn't read env files itself, so export
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
`envs/<env>`, with the account id and domain coming from that GitHub
Environment rather than a `.tfvars` file.

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
