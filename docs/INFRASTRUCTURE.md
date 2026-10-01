# Infrastructure

Status: **both environments are built.** Staging is `api.staging.` /
`cdn.staging.joinmimoza.com`, prod is `api.` / `cdn.joinmimoza.com`,
each in its own AWS account with its own alarms, signing key and deploy
role. The website is `joinmimoza.com`, on Cloudflare Pages. What is
still open is on the [launch checklist](LAUNCH_CHECKLIST.md); each
section below marks what is deferred.

---

## The shape of it

One Go binary on Lambda, two CloudFront distributions in front of it, and
four DynamoDB tables plus one S3 bucket behind. No servers, no containers,
no VPC, no database to patch or scale. Everything is on-demand, so an idle
environment costs almost nothing and a busy one needs no capacity plan.

```
Cloudflare DNS
  │
  ├─ api.<zone> ──→ CloudFront ──→ Lambda URL ──→ relay (Go, arm64)
  │   DNS only      CachingDisabled                no VPC, on-demand
  │                 all headers but Host                │
  │                                                     ├─→ DynamoDB ×4
  │                                                     │   PAY_PER_REQUEST
  │                                                     ├─→ S3  issue URLs,
  │                                                     │       delete objects
  │                                                     ├─→ SSM config + keys
  │                                                     └─→ APNs / FCM
  │
  ├─ cdn.<zone> ──→ CloudFront ──→ S3 bucket
  │   DNS only      cached          OAC only — no direct reads
  │                 signed URLs      ▲
  │                                  └── presigned POST, straight from the app
  │
  └─ joinmimoza.com ──→ Cloudflare Pages ──→ static site (Vite)
      proxied                                └─ /api/subscribe → Resend (waitlist)

One AWS account per environment, all of it in us-east-1.
```

`api.` and `cdn.` are **"DNS only"**, never proxied — proxying would
stack two CDNs. The apex is proxied because that is what Pages is.

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
| `<prefix>-circles` | One partition per circle: meta, members, sealed keys, invites, requests, posts, activity and children. |
| `<prefix>-accounts` | One partition per account: profile, devices, linked providers, device-link sessions, and the Apple refresh token deletion revokes with. |
| `<prefix>-sessions` | Bearer tokens this relay issued. TTL on `expiresAt`. |
| `<prefix>-rate-limit` | Per-account request budgets. |
| `<prefix>-blobs` (S3) | Photo, cover and avatar ciphertext. Glacier IR after 90 days. |
| SSM `/<prefix>/*` | Settings, and the four SecureString credentials. |
| Firebase, one project per env | Outside AWS: push (FCM), crash reports and usage analytics from the app. Route patterns and three parameterless events — no ids, no content; see `RELAY_DESIGN.md`, *Telemetry*. |

Every AWS name derives from `RESOURCE_PREFIX` on both sides —
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
the relay's own. Every route requires it except sign-in. Budgets are
counters in DynamoDB, two per account in a fixed ten-minute window: 500
writes and 2,000 reads by default (`RATE_LIMIT_*`). There is no WAF; see
*Cost* for why.

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

**CloudFront over the Lambda function URL, at `api.<env_domain>`.**

`EXPO_PUBLIC_RELAY_URL` is compiled into each app build
(`app/src/core/services/relay.ts`), so installed apps dial that hostname
forever. An AWS-generated URL cannot be that hostname — it must be a name
we control before any build ships to a real user.

- Cache policy `CachingDisabled`, origin request policy
  `AllViewerExceptHostHeader` — the relay serves per-user encrypted data,
  so nothing here is cached. Blobs are the opposite; see below.
- **The function URL stays publicly callable** (`behind_cloudfront` and
  `sign_origin_requests`, both false in every env). Origin access control
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

Built as `modules/cdn`, inert until `env_domain` is set — with it empty,
`api_endpoint` stays the raw function URL. Certificate validation is
manual: the first apply blocks on the record, which the `cdn` output
prints for adding at Cloudflare.

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
- **Every key is immutable** — `<circleId>/<postId>` for a photo,
  `<circleId>/cover/<coverId>` for a cover,
  `<circleId>/avatar/<accountId>/<avatarId>` for a member's picture. A
  changed cover or picture is a new id, never an overwrite, so all three
  take a long TTL and none needs an uncached path.
- **Invalidate on delete only.** Nothing else ever changes. One path per
  photo; one wildcard (`/<circleId>/*`) per circle for bulk deletion,
  which counts as a single path. First 1,000 paths/month free,
  account-wide. Best-effort: the bytes are already destroyed by then, so
  a failed invalidation is logged rather than failing the delete.
- Invite previews carry no blob — a name and a member count, nothing
  more. No pre-membership blob access.

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
- The key was generated by hand, once per environment:
  `openssl genrsa 2048` → private half to SSM, public half to
  `envs/<env>/cloudfront-signing-key.pub`. Both environments have one.

---

## Backups

**Point-in-time recovery on `circles` and `accounts`, in prod only.**

PITR is not snapshots and there is no interval to tune: it captures
changes continuously and restores to any second in the last 35 days, by
building a **new table**. It cannot roll one row back and it cannot be
queried as history — it is disaster recovery, not an audit log, and not a
debugging tool. It also only covers what happened after it was switched
on, which is why it went on before launch rather than after the first
incident.

Those two tables because they are the ones holding what nobody else can
reconstruct: every circle's content and roster, and the accounts behind
them. `sessions` and `rate-limit` are ephemeral by design (expiry,
counters). Losing `circles` loses the photos outright — devices hold
only what they have synced, and no member can rebuild another's.

There is no floor under this. A device holds only the circles it belongs
to and only what it has synced, so relay data loss is not something the
fleet can heal from. At $0.20/GB-month against tables holding ciphertext
and metadata — the photos are in S3, not here — this is cents a month
for years.

**Blobs have no backup, and the obvious fix is ruled out.** Versioning is
off deliberately (`modules/storage/s3.tf`): deleting a post, a circle or
an account has to actually destroy the bytes, and versioning would lay
delete markers over recoverable copies instead — the delete would appear
to work while quietly keeping everything. So the gap is real, but closing
it needs something that can tell "deleted on purpose" from "lost", which
versioning cannot. Nothing here is built.

---

## Deploys

Three pipelines, all in `.github/workflows/`, all with the same shape:
`main` is staging, a tag is production.

```
                 push to main              tag
relay    server/**  ─→ Server Tests ─→ staging     server-v*  ─→ prod
app      app/**     ─→ Deploy App   ─→ staging     app-v*     ─→ production
website  landing/** ─→ Deploy Landing ─→ joinmimoza.com (one environment)
```

GitHub Environments (`staging`, `production`) hold each side's secrets.
AWS access is OIDC — no stored keys; the trust policy names the repo and
environment. Everything else (store API keys, signing, EAS, Firebase,
Cloudflare) is a plain Environment secret.

**Relay first, then the app.** One relay serves every installed version,
and a rollback can't unwrite what new clients appended — older clients
skip entry types they don't know (`SYNC_DESIGN.md`, *The outbox*).

### The relay

Server Tests green on `main` → `terraform apply` + function update in
staging. Those tests only run on `server/**`, so a merge touching only
`app/` deploys nothing. A `server-v*` tag does the same in prod. One
deploy at a time per environment, and **never cancel one midway**:
Terraform holds a state lock, and a killed apply leaves it held by a run
that no longer exists.

### The app

`Deploy App` decides per push whether the installed binaries can run this
JavaScript, and ships one of two things — never both:

```
test (lint + jest, Ubuntu)
  └─ fingerprint: expo-updates fingerprint per platform
       vs shipped-fingerprints.json (repo root)
         ├─ unchanged ──→ eas update --channel <staging|production>
         └─ changed   ──→ fastlane ios      → TestFlight
                          fastlane android  → staging: Firebase App Distribution (APK)
                                              production: Play internal track (AAB)
                          then record the new fingerprints (a commit, [skip ci])
```

- A release tag, `[build]` in the commit message, or the `force` input
  on a manual run makes it a native build regardless.
- Signing: iOS certificates and profiles through `match`; the Android
  upload keystore lives in the same certificates repo, its password in
  `ANDROID_KEYSTORE_PASSWORD`. `prebuild --clean` regenerates `ios/` and
  `android/` every run, so nothing is edited in place.
- Updates are unsigned: EAS code signing is gated behind a paid tier, so
  `EXPO_TOKEN` is the only thing between a compromise and arbitrary JS on
  a device. Worth remembering when deciding who may hold it.
- Production lands in TestFlight and Play internal; submitting to the
  stores is a hand step from there. The listings have their own lanes
  (`fastlane ios listing`, `fastlane android listing`).

**Build numbers come from CI, never from `app.json`.** The run number,
floored at the store's latest plus one (TestFlight for iOS, the Play
internal track for Android), so iOS and Android land on the same number
and a re-run can't claim one the store already has. Locally
`APP_BUILD_NUMBER` is unset and `app.json`'s `1` is the fallback; every
upload burns a number permanently, so two builds from one commit still
need two. The version is plain semver in `app.json`. The account screen
shows version, native build and the run that published the current JS
(`extra.jsBuild`) — the last two differ once an update has landed, which
is the point.

**A push that only changes JavaScript ships as an update within minutes
of merging.** That includes anything under `migrations/`: the fingerprint
covers native code, not SQL, and `decide-build.sh` does not look at
paths. A JS-only update can carry a migration, and rolling that update
back leaves old JS against a newer schema. Put `[build]` in the commit
message for anything touching `migrations/`, so it goes out as a binary.

Client migrations apply by index in one transaction and are gap-safe
(`app/src/data/db/migrations/run.ts`), but every test starts from an empty
database — the **upgrade-with-data path is untested**. Install the previous
staging build, use it, then install the new one *over* it. Deleting the
app between builds is what makes staging pass and real upgrades fail.

| | Staging | Prod |
|---|---|---|
| Bundle ID | `com.eozsahin.mimoza.staging` | `com.eozsahin.mimoza` |
| Relay URL | `api.staging.joinmimoza.com` | `api.joinmimoza.com` |
| iOS | TestFlight, internal | TestFlight → App Store |
| Android | Firebase App Distribution | Play internal → production |
| Update channel | `staging` | `production` |

A separate bundle ID means its own Firebase app, its own Google/Apple
sign-in client IDs (the relay's `GOOGLE_CLIENT_ID_*` / `APPLE_CLIENT_ID_IOS`
must match per env), and its own `APNS_TOPIC` — the topic *is* the bundle
ID. The APNs `.p8` key is shared.

**Push has two environments, and a build registers against one.** The
`aps-environment` entitlement is keyed on `APNS_PRODUCTION`
(`app.config.js`), which CI sets for every TestFlight build and a local
Xcode run does not — only a distribution profile may carry the production
entitlement. A sandbox token sent to production APNs is rejected as
unregistered, silently: the build registers, the relay accepts the token,
and nothing ever arrives. So a relay's `APNS_PRODUCTION` must agree with
the builds it serves, and push on a build run from Xcode can only be
tested against a relay set to sandbox.

### The website

`landing/` is a Vite site plus one Cloudflare Pages Function
(`functions/api/subscribe.ts`, the waitlist, which is the only place
`RESEND_API_KEY` is used). `Deploy Landing` builds and runs
`wrangler pages deploy` on every push touching `landing/**`. The site is
on Pages rather than GitHub Pages only because of that function; once
the app is live and the waitlist goes (`src/config.ts`, `APP_IS_LIVE`),
a plain `actions/deploy-pages` would do. Pages serves `index.html` for
any path it has no file for, so an unbuilt route 200s with the homepage —
`/privacy/` is a second Vite input, not a client route, for exactly that
reason.

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
   latency alarms and the tables' throttle alarms; on in both
   environments, each to its own confirmed address.
2. Lambda reserved concurrency — free, caps how fast money can leave.
   Off in both envs today (`reserved_concurrency = -1`): a new account's
   10-execution limit refuses a reservation. Every table is
   `PAY_PER_REQUEST`, so until it goes on nothing bounds spend.
3. WAF — deferred. ~$6/month per environment, and the account-level rate
   limiter already handles fairness. IP rules are a cost shield, not a
   replacement: shared carrier and household IPs force loose thresholds.

---

## Deferred

- **Cloudflare R2 for blobs** — zero egress, S3-compatible. Revisit if
  bandwidth becomes a real line item; splits providers.
- **Origin Shield** — collapses edge misses into one origin fetch. Pays
  off only once origin fetches cost something.
- **Parallel photo downloads** — the queue drains one at a time
  (`app/src/core/photo/photo-queue.ts`), which is slow on high-latency
  links. Edge caching addresses the same symptom first.
