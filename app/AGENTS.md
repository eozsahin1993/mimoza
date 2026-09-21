# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Running tests

```bash
npm test
```

That runs jest through `fnm exec --using=22.23.2`, matching
`.node-version` and CI. The pin is the whole point: under any other Node,
`npx jest` can hang indefinitely (not error — just never return, and the
stuck process resists even `kill -9`) because the active version's ABI
doesn't match the native SQLite binding (`better-sqlite3`, used by
`expo-sqlite-mock` in tests) that `node_modules` was installed under. A
plain Homebrew/system `node` on the PATH is the common mismatch.

If a run finishes but never hands control back, add `--forceExit`;
`--runInBand` hasn't been proven necessary but has been reliable where the
default worker-process model has not. Real CI
(`.github/workflows/app-unit-test.yml`) runs plain `npx jest --ci` on Node
22.23.2 and passes quickly with no special flags — reach for either flag
as a symptom of the shell, not of the suite.

## After editing a migration `.sql`, run tests with `--no-cache`

Jest caches the transformed contents of `src/data/db/migrations/*.sql`
and does **not** reliably invalidate that cache when one changes. Tests
then run the *old* migration against the *new* `schema.ts`, and fail with
a thoroughly misleading error:

```
SqliteError: table pending_join_requests has no column named circle_id
```

— pointing at a column the migration visibly does declare. It's a stale
cache, not a broken migration. Re-run with `--no-cache` once after
touching any migration:

```bash
npm test -- --no-cache
```

Everyday runs (no migration changes) don't need it.

## Icons in tests are mapped to lucide's CommonJS build

`jest.moduleNameMapper` sends `lucide-react-native/icons/*` at the package's
`dist/cjs` copy. Jest resolves that subpath to the ESM `.mjs` otherwise, and
the preset's transform only matches `.[jt]sx?` — so the icon never gets
compiled and every test that touches `ui/theme/tokens.ts` dies with a
misleading `Cannot use import statement outside a module`. Metro is
unaffected and takes the ESM build as normal.

## Always add a new migration — never edit an existing one

`migrations/run.ts` tracks applied migrations by **index**, so editing a
migration that a device has already run does nothing: the index is
recorded, the file is skipped, and the schema silently stays behind. The
symptom is a confusing runtime error naming a column the migration file
plainly declares:

```
table outbox has no column named entry_id
```

Migrations `0000`–`0005` were deliberately consolidated so each declares
its table's final shape, and that's the baseline. From there on, a schema
change means editing `schema.ts` and running:

```bash
npm run db:generate
```

which writes the next numbered migration. Don't reach for the old
consolidate-in-place habit to keep the history tidy — it costs every
device a wipe, and eventually one you can't reach.

## Fingerprints are per environment, so compare like with like

`npm run fingerprint:dev|staging|prod` hashes what a native build is made
of, which answers the only question that matters before shipping: does
this change need a new binary, or will the JS bundle carry it?

The three are not interchangeable. The hash covers the resolved app
config, and `app.config.js` gives each environment its own bundle id and
App Group, so the same commit fingerprints differently per environment
(the APNs entitlement is not per-environment — it follows
`APNS_PRODUCTION`, which only the fastlane lanes set):

```
production  69c7f5c76f98e42b5583c23f6126fbb4c0e0f0c6
staging     f89f05343453ed02a2332628ff60145e13de79c2
```

Diff a hash against the one from that environment's last build, never
against another environment's. `fingerprint fingerprint:diff <a> <b>`
takes two generated files and names what moved.

Adding a dependency changes the hash even when it ships no native code —
the tool can't know, so it assumes a rebuild. That's the right way round;
the expensive mistake is shipping JS against a binary that can't run it.
