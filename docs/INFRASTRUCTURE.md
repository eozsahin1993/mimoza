# Infrastructure

Status: **staging is built** — its own account, both distributions, the
relay behind `api.staging.joinmimoza.com`. Blobs are the exception:
Terraform writes the settings parameter with the distribution, so signing
waits only on the hand-created `cloudfront-signing-key` in SSM — without
it downloads stay on presigned S3, silently (below). Prod is configured
but unverified here: its account id, domain, alert email and signing key
are checked in (`envs/prod/prod.auto.tfvars`), with deletion protection
and PITR on; whether an apply has run is only visible in its remote
state. Each section marks what is
decided, open, or deferred.

---

## The shape of it

One Go binary on Lambda, two CloudFront distributions in front of it, and
six DynamoDB tables plus one S3 bucket behind. No servers, no containers,
no VPC, no database to patch or scale. Everything is on-demand, so an idle
environment costs almost nothing and a busy one needs no capacity plan.

```
Cloudflare DNS — "DNS only", never proxied: proxying would stack two CDNs
  │
  ├─ api.<zone> ──→ CloudFront ──→ Lambda URL ──→ relay (Go, arm64)
  │                 CachingDisabled                no VPC, on-demand
  │                 all headers but Host                │
  │                                                     ├─→ DynamoDB ×6
  │                                                     │   PAY_PER_REQUEST
  │                                                     ├─→ S3  issue URLs,
  │                                                     │       delete objects
  │                                                     └─→ SSM config + keys
  │
  └─ cdn.<zone> ──→ CloudFront ──→ S3 bucket
                    cached          OAC only — no direct reads
                    signed URLs      ▲
                                     └── presigned POST, straight from the app

One AWS account per environment, all of it in us-east-1.
```

ACM issues one wildcard certificate per environment, in us-east-1 because
CloudFront accepts them from nowhere else. Validation is a DNS record
added at Cloudflare by hand — the first apply in a new environment blocks
until it exists.

**Photo bytes never pass through the relay.** Uploads go straight to S3 on
a presigned POST the relay hands out; downloads come from the edge on a
CloudFront signed URL. The relay only ever issues the URL and records that
the entry exists — which is what keeps a 2 MB photo off a Lambda that
charges by the millisecond, and what makes the same object cacheable for
every member of a circle.

**Where the data lives:**

| | |
|---|---|
| `<prefix>-sync-log` | The archive. One partition per circle, append-only, never mutated. |
| `<prefix>-accounts` | One document per account: the encrypted recovery manifest, and the Apple refresh token deletion revokes with. |
| `<prefix>-sessions` | Bearer tokens this relay issued. |
| `<prefix>-invites` | Invites and pending join requests, on a TTL. |
| `<prefix>-rate-limit` | Per-account request budgets. |
| `<prefix>-push` | Routing preferences and one row per device. |
| `<prefix>-blobs` (S3) | Photo ciphertext. Glacier IR after 90 days. |
| SSM `/<prefix>/*` | Settings, and the four SecureString credentials. |

Every one of those names derives from `RESOURCE_PREFIX` on both sides —
`internal/config` and `modules/storage` — so an environment is one string,
and nothing can be pointed at another environment's data piecemeal.

**Configuration and secrets both live in SSM, but reach the relay by two
different routes**, and the difference matters when something looks stale:

| | | |
|---|---|---|
| Tuning — blob size cap, retention, rate limits | `envs/*/main.tf` | In git; a change is a reviewable diff, applied by `terraform apply` alone |
| Settings only a human has — sign-in client IDs, APNs/Apple key ids | SSM `/<prefix>/config/*` | Uploaded by `push-config.sh`, read by Terraform **at apply time** and baked into the function's environment |
| Credentials — the four `.p8`/JSON/RSA keys | SSM SecureStrings | Never in Terraform state; read by the relay **at runtime**, cached per cold start |
| Where the blob CDN is | SSM `/<prefix>/cdn` | Written by Terraform, read by the relay at runtime — closes a dependency cycle, see *How the relay finds the CDN* |

The consequence worth remembering: a `/config/*` change needs
`push-config.sh` **and** an apply, because nothing re-reads it at runtime;
a SecureString change needs only a cold start. Nothing is stored in the
repo, in CI, or on a developer's machine except `<env>.env`, which is
gitignored.

**Everything the relay serves is ciphertext it cannot read.** That is the
constraint the rest of this document keeps running into: it is why blobs
can be cached and shared, why logs carry no identifiers, why a backup
restores something only the user's device can open, and why the relay
cannot select a circle's rows to fix them.

**Auth and rate limiting are both the relay's own, not AWS's.** Sign-in
verifies a Google or Apple ID token against that provider's JWKS over
plain HTTPS — no AWS permission involved — and issues a bearer token of
the relay's own. Every route requires it except sign-in, `POST
/push/send` — unauthenticated by design (`PUSH_DESIGN.md`) — and
`POST /auth/logout`, which sits outside the session middleware because it
validates and burns the token itself.
Budgets are counters in DynamoDB, applied per handler: writes and reads
carry different limits, and push recipients carry a third. There is no
WAF; see *Cost* for why.

---

## Accounts

One AWS account per environment. A mistake in staging cannot reach prod
when the credentials can't see it.

| Account | Root email | Holds |
|---|---|---|
| Management | `<user>+aws-root@gmail.com` | Organization and sign-in only |
| Prod | `<user>+mimoza-prod@gmail.com` | `envs/prod` |
| Staging | `<user>+mimoza-staging@gmail.com` | `envs/staging` |

`envs/local` runs against LocalStack and needs no account.

**Root emails are Gmail plus-addresses, never the domain.** A lapsed
domain hands account recovery to whoever registers it next. Never use an
email whose domain is registered inside the account it recovers.

Per account: Terraform state bucket (`mimoza-terraform-<env>`), deploy
role, and the SSM SecureStrings kept out of Terraform, which would put
them in state as plaintext — `/mimoza-<env>/fcm-service-account`,
`/mimoza-<env>/apns-auth-key` and `/mimoza-<env>/apple-signin-key`, all
three uploaded by `push-config.sh`, and
`/mimoza-<env>/cloudfront-signing-key` by hand. The last two differ by one
letter and are unrelated: `signin` is the Sign in with Apple key,
`signing` the RSA key that signs blob URLs.

The Lambda's environment merges the tuning block with the `/config/*`
parameters, prefix last (`modules/lambda/lambda.tf`), so nothing can
override `RESOURCE_PREFIX` — every table, bucket and parameter path
derives from it.

Shared across accounts: the APNs `.p8` key, which is team-wide and works
against both Apple's sandbox and production hosts. Everything else is
per-environment, because it is tied to that environment's bundle id — the
sign-in client IDs, `APNS_TOPIC`, and the Sign in with Apple key, whose
primary App ID is the app it belongs to.

Providers take `aws_profile` and `aws_account_id`, so applying with the
wrong credentials fails instead of building in the wrong place. Neither is
committed — locally they come from a gitignored `<env>.auto.tfvars` (copy
the `.example` beside it) or the environment, in CI from GitHub
Environment secrets beside the role ARN:

```bash
export AWS_PROFILE=mimoza-staging
export TF_VAR_aws_account_id=<account>
```

---

## The front door

**CloudFront over the Lambda function URL, at `api.<env_domain>`** —
`api.staging.joinmimoza.com` today, and whatever zone prod is given.

`EXPO_PUBLIC_RELAY_URL` is compiled into each app build
(`app/src/core/services/relay.ts`), so installed apps dial that hostname
forever. An AWS-generated URL cannot be that hostname — it must be a name
we control before any build ships to a real user.

- Cache policy `CachingDisabled`, origin request policy
  `AllViewerExceptHostHeader` — the relay serves per-user encrypted data,
  so nothing here is cached. Blobs are the opposite; see below.
- DNS at Cloudflare, **"DNS only"**. Proxying would stack two CDNs.
- **The function URL stays publicly callable** (`behind_cloudfront` and
  `sign_origin_requests`, both false in staging and prod; local runs no
  Lambda at all). Origin access control
  is built and can be switched on, but Lambda rejects unsigned payloads:
  every POST/PUT would have to carry `x-amz-content-sha256` with the
  body's hash, put there by the client.
  An edge function can't — it never sees the body. Making the app aware of
  how its origin is protected is the wrong contract, so the lock is off.
  The hostname is 32 random characters and isn't in certificate
  transparency (Lambda serves it under a wildcard), so it is obscurity,
  not access control — what's behind it is the same bearer-token auth.
  **If bypass ever matters** (a WAF worth enforcing, say), the fix is API
  Gateway in place of the function URL: the Lambda stops being publicly
  reachable and nothing is asked of the client, for ~$1/M requests.
- Free tier covers it: 1 TB out, 10M requests/month, permanent.

Sync payloads still gain from the nearby TLS handshake and the AWS
backbone on the long leg.

Built as `modules/cdn`, wired into both envs but inert until `env_domain`
is set — with it empty, `api_endpoint` stays the raw function URL.
Certificate validation is manual: the first apply blocks on the record,
which the env-level `dns_records` output prints for adding at Cloudflare
(it comes from `modules/certificate`, not `modules/cdn`).

---

## Blob delivery

**Downloads via CloudFront signed URLs at `cdn.<env_domain>`. Uploads stay
presigned S3 POSTs direct to the bucket.**

Every member of a circle downloads identical ciphertext, so the second
reader onward should be served from the edge.

- **S3 reachable only via the distribution** (origin access control), or
  old-style URLs bypass signing and the cache.
- **Signing parameters stay out of the cache key**, so all members share
  one object: the cache policy sets query strings to `none`, and
  CloudFront strips `Expires`/`Key-Pair-Id`/`Policy`/`Signature` before
  the origin sees them.
- **Post photos are immutable** (`<syncId>/<entryId>`) — long TTL.
- **Covers overwrite in place** at `<syncId>/cover`
  (`internal/synclog/s3/blob_store.go`), so that path is **uncached**
  until the hash moves into it — `cover_photo_set` already carries
  `photoHash`, so devices know it before fetching.
- **Invalidate on delete only.** Nothing else ever changes. One path per
  photo; one wildcard (`/<syncId>/*`) per circle for bulk deletion, which
  counts as a single path. First 1,000 paths/month free, account-wide.
  Best-effort: the bytes are already destroyed by then, so a failed
  invalidation is logged rather than failing the delete.
- Invite previews carry no blob — name and avatar ride inline, encrypted
  under the invite key (`INVITE_FLOW.md`). No pre-membership blob access.

Provider portability comes from the domain plus the relay handing out
URLs at request time; clients never see S3. Signing is CloudFront-specific
and stays behind the `BlobStore` interface.

### How the relay finds the CDN

The distribution needs the Lambda's function URL, so the Lambda can't be
told about the distribution in its own environment — that closes a
dependency cycle. **SSM is the handover instead: Terraform writes what it
created, the relay reads it at runtime.**

| | |
|---|---|
| `/mimoza-<env>/cdn` | `{baseUrl, keyPairId, distributionId}` as JSON, written by `modules/cdn`. One parameter, so a read can't see a half-updated set. Not secret. |
| `/mimoza-<env>/cloudfront-signing-key` | The RSA-2048 private key, **created by hand** — Terraform would put it in state. |

Both paths are derived from `RESOURCE_PREFIX` on each side
(`internal/config`, `modules/cdn/blobs.tf`), and nothing checks the two
spellings against each other.

**Whether blobs come from the CDN is a runtime answer, not configuration.**
`internal/synclog/cdn` reads the settings parameter once per cold start:
present means sign CloudFront URLs, `ParameterNotFound` means keep
presigning S3. That is what makes local runs work unchanged — LocalStack
has SSM but no CloudFront — and it means switching an environment over is
an apply, with no redeploy.

Consequences worth knowing:

- A warm Lambda keeps what it read. Changes land on the next cold start,
  or immediately after a deploy.
- Deploy Terraform before code that needs a new field: old parameter plus
  new code fails the shape check and falls back to S3, quietly.
- Generating the key is manual, once per environment:
  `openssl genrsa 2048` → private half to SSM, public half to
  `blob_signing_public_key`.

---

## Backups

**Point-in-time recovery on `sync-log` and `accounts`, in prod only.**

PITR is not snapshots and there is no interval to tune: it captures
changes continuously and restores to any second in the last 35 days, by
building a **new table**. It cannot roll one row back and it cannot be
queried as history — it is disaster recovery, not an audit log, and not a
debugging tool. It also only covers what happened after it was switched
on, which is why it goes on before launch rather than after the first
incident.

Those two tables because they are the ones holding data nobody else can
reconstruct — the archive itself, and the encrypted recovery manifest.
`sessions`, `invites` and `rate-limit` are all ephemeral by design
(expiry, TTL, counters), and `push` self-heals as devices re-register.

This is worth paying for despite the recovery floor in `SYNC_DESIGN.md`
("every device holds the full archive and all keys locally"), because that
floor has one hole: it assumes a device survived. Relay data loss *and* a
dead phone leaves nothing to re-upload from. At $0.20/GB-month against
tables holding ciphertext and metadata — the photos are in S3, not here —
this is cents a month for years.

**Blobs have no backup, and the obvious fix is ruled out.** Versioning is
off deliberately (`modules/storage/s3.tf`): deleting a post, a circle or
an account has to actually destroy the bytes, and versioning would lay
delete markers over recoverable copies instead — the delete would appear
to work while quietly keeping everything. So the gap is real, but closing
it needs something that can tell "deleted on purpose" from "lost", which
versioning cannot. Nothing here is built.

## Deploys

GitHub Environments (`staging`, `production`), each holding its own
`AWS_ROLE_ARN`, `AWS_ACCOUNT_ID`, `ENV_DOMAIN` and `ALERT_EMAIL` as
secrets. OIDC — no stored AWS keys; the trust policy names the repo and
environment.

- Server Tests green on `main` → staging, or `workflow_dispatch` by hand.
  Those tests only run on `server/**` and the workflow file itself, so a
  merge touching only `app/` deploys nothing.
- A `server-v*` tag → prod, through the `production` environment.

The app has no pipeline of its own: `app-unit-test.yml` lints and runs
Jest and stops there, so builds and submissions are local.

**Relay first, then the app.** One relay serves every installed version,
and a rollback can't unwrite what new clients appended — older clients
discard entry types they don't know (`SYNC_DESIGN.md` invariant 5).

### App builds

One build per environment; `EXPO_PUBLIC_RELAY_URL` is compiled in, so the
environment is fixed at build time.

| | Staging | Prod |
|---|---|---|
| Bundle ID | `com.eozsahin.mimoza.staging` | `com.eozsahin.mimoza` |
| Relay URL | `api.staging.joinmimoza.com` | `api.<prod zone>` |
| Distribution | TestFlight internal | App Store |

A separate bundle ID means its own Firebase app, its own Google/Apple
sign-in client IDs (the relay's `GOOGLE_CLIENT_ID_*` / `APPLE_CLIENT_ID_IOS`
must match per env), and its own `APNS_TOPIC` — the topic *is* the bundle
ID. The APNs `.p8` key is shared. `APNS_PRODUCTION` already selects
sandbox versus production.

Version is plain semver; the build number is separate
(`ios.buildNumber`, `android.versionCode` — iOS needs a unique build per
version, Android a strictly increasing integer). `app.json` carries `1` as
a local fallback; a shipped build gets its number from fastlane, which
asks TestFlight for the last one and adds one (`APP_BUILD_NUMBER`, read by
`app.config.js`). There is no EAS config and no app build workflow. Surface `1.0.0 (15) · <commit> · <env>` in-app:
the SHA is the only identifier that can't drift.

### Verifying an upgrade

Client migrations apply by index in one transaction and are gap-safe
(`app/src/data/db/migrations/run.ts`), but every test starts from an empty
database — the **upgrade-with-data path is untested**. Install the previous
staging build, use it, then install the new one *over* it. Deleting the app
between builds is what makes staging pass and real upgrades fail.

Adopting OTA (`expo-updates`, not installed) changes this: a JS-only
update can carry a migration, and rolling that update back leaves old JS
against a newer schema. Treat anything touching `migrations/` as a native
release.

---

## Cost

Estimate at 1,000 monthly users, ~3 photos each, with CloudFront:

| | |
|---|---|
| Lambda (~1.6M invocations) | ~$1 |
| DynamoDB (~6M ops, on-demand) | ~$1.50 |
| S3 storage (6 GB/month added) | ~$0.15 |
| CloudFront, S3 egress | $0 (free tier; S3→CloudFront is free) |
| **Total** | **~$3–4/month** |

Bandwidth stops mattering until ~1 TB/month (~500k photo downloads).
Requests bind first: the 30s foreground sync caps out near 10M/month
around ~6k users, and that cadence is tunable.

Accounts created after 2025-07-15 get credits, not the old 12-month free
tier. Storage accumulates; nothing deletes photos unless asked.

**Guardrails, in order:**

1. Billing alarm — free, and the one that catches a month going wrong.
   Built as `modules/alarms` beside the relay's throttle, error and
   latency alarms; all of them off until `alert_email` is set.
2. Lambda reserved concurrency — free, caps how fast money can leave.
   Off in both envs today (`reserved_concurrency = -1`): a new account's
   10-execution limit refuses a reservation. Every table is
   `PAY_PER_REQUEST`, so until it goes on nothing bounds spend.
3. WAF — deferred. ~$6/month per environment, and the account-level rate
   limiter already handles fairness. IP rules are a cost shield, not a
   replacement: shared carrier and household IPs force loose thresholds.

`POST /push/send` is unauthenticated by design (`PUSH_DESIGN.md`) — the
one endpoint reachable without an account.

---

## Deferred

- **Cloudflare R2 for blobs** — zero egress, S3-compatible. Revisit if
  bandwidth becomes a real line item; splits providers.
- **Origin Shield** — collapses edge misses into one origin fetch. Pays
  off only once origin fetches cost something.
- **Parallel photo downloads** — the queue drains one at a time
  (`app/src/core/photo/photo-queue.ts`), which is slow on high-latency
  links. Edge caching addresses the same symptom first.
