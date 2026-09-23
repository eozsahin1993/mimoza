# Staging build checklist

Cutting an internal build and getting it onto a phone. Staging is a
separate app, not a flag inside one — its own bundle id, App Group,
Firebase project and relay (`app/app.config.js`) — so most of what goes
wrong here is a build that carries one environment's identity and another
one's configuration.

The relay goes first. An app build is pinned to a relay URL at compile
time, so a staging app against a relay that hasn't deployed yet is a
rebuild, not a retry.

## Before you build

- [ ] `eval "$(fnm env)" && fnm use` — Node 22.23.2, the version
      `node_modules` was installed against. A mismatched Node makes
      `npx jest` hang forever rather than fail, and the process resists
      `kill -9` (`app/AGENTS.md`).
- [ ] `npx jest --ci --forceExit --runInBand` green. Add `--no-cache`
      once if any `migrations/*.sql` changed — Jest caches the old SQL and
      fails naming a column the migration visibly declares.
- [ ] Schema change? A **new** numbered migration from `npm run
      db:generate`, never an edit to one a device has already run —
      `migrations/run.ts` tracks by index, so an edited migration is
      silently skipped.
- [ ] Changed any `push.*` string? `npm run i18n:ios`. The notification
      extension can't read the app's locale JSON and keeps its own
      `Localizable.xcstrings` copy; `push-copy-parity.test.ts` fails until
      you regenerate it.
- [ ] `npx expo lint`.

## The relay

- [ ] Deploy Relay went green for the commit you're building against.
      It runs on a successful Server Tests run on `main`, or by
      `workflow_dispatch`. Never cancel one midway — Terraform holds a
      state lock, and a killed apply leaves it held by a run that no
      longer exists.
- [ ] Changed `server/staging.env`? `provision/push-config.sh staging`
      **and then** `terraform apply`. The script only writes SSM;
      Terraform reads `/config/*` at apply time, so uploading alone
      changes nothing the Lambda sees.
- [ ] `terraform output api_endpoint` in `envs/staging` matches
      `EXPO_PUBLIC_RELAY_URL` in `app/.env.staging`. There is no health
      endpoint to curl — every route is under `/v1/` and expects a real
      request, not a probe — so this comparison is the check.

## Building

- [ ] `npm run prebuild:staging`. `/ios` and `/android` are gitignored
      generated output; regenerate them rather than editing in place, or
      the fix disappears on the next prebuild.
- [ ] Confirm the build took staging's identity, not prod's: bundle id
      `com.eozsahin.mimoza.staging`, App Group
      `group.com.eozsahin.mimoza.staging`, `google-services.staging.json`
      (Firebase project `mimoza-staging`). The App Group is the one that
      matters — a shared group would mean staging reading prod's account
      keypair and content keys.
- [ ] iOS: `npm run ios:staging`. Android: `npm run android:staging`.
      Both load `.env.staging` through `dotenv`; a bundler started
      without it now fails the build instead of quietly inlining dev's
      relay (`requireEnvironment` in `app.config.js`).

## On the device

- [ ] Staging and production installed side by side, and you know which
      one you're holding — staging has its own icon and a " Staging" name
      suffix.
- [ ] The env badge names the environment. It renders for anything but
      production (`app/src/ui/components/env-badge.tsx`), so a missing
      badge on a build you meant to be staging means the build is wrong.
- [ ] Sign in with Apple and with Google, both against staging's own
      OAuth clients.
- [ ] Fresh install all the way through: onboarding, profile, create a
      circle, post a photo.
- [ ] Recovery, on a second device: sign in, and confirm the account
      keypair carried across via iCloud Keychain (or a fresh one is
      published and another member's device reseals it — see
      `RELAY_DESIGN.md`'s New device section).

## Two things that will bite

**Push doesn't work over TestFlight on a staging build.** Staging carries
`aps-environment: development`, so it registers a sandbox APNs token,
while TestFlight and the App Store both run against production APNs. The
build registers, the relay accepts the token, and nothing ever arrives —
no error anywhere. Test push on a build installed from Xcode, or use a
production build (commit a356a70 is the fix, and only `APP_ENV=production`
flips the entitlement).

**Android release artifacts are signed with the debug keystore**
(`android/app/build.gradle`, still the Expo default). Fine for
sideloading a staging build; Play internal testing needs the real upload
key, which is an unticked item on the [launch
checklist](LAUNCH_CHECKLIST.md).
