# Mimoza app

The Expo/React Native client. Routes live in `src/app` (expo-router);
everything else sits under `src/core`, `src/data`, `src/features` and
`src/ui`. Conventions and traps are in [AGENTS.md](AGENTS.md); the design
docs are in [`../docs`](../docs/README.md).

## Get started

1. `npm install`
2. Copy `.env.example` to `.env.dev` and fill it in.
3. `npm run start`, or `npm run ios` / `npm run android` to build and
   install natively.

Expo Go can't run this — Google Sign-In, the notification service
extension and the rest of the native modules need a development build.

`start`, `ios`, `android` and `prebuild` each load one env file
explicitly: no suffix is dev, `:staging` and `:prod` load `.env.staging`
and `.env.production`. Never create `.env` or `.env.local`; Expo loads
those on top of whatever the script passed, so their values end up in
every build regardless of environment.

The `ios` scripts pin `--device "iPhone 17"`, so they fail outright
without that simulator.

`npm run prebuild` (same suffixes) regenerates `ios/` and `android/` after
a change to `app.config.ts`, `app.json` or a config plugin.

## Other commands

- `npm test` — read [AGENTS.md](AGENTS.md) first; the Node version is
  load-bearing.
- `npm run lint`
- `npm run db:generate` — writes the next migration after you edit
  `src/data/db/schema.ts`. Never edit an existing one (AGENTS.md).
- `npm run i18n:ios` — regenerates the notification extension's strings
  from `src/core/i18n/locales`. `push-copy-parity.test.ts` fails until you
  have.
