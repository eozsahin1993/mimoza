# Launch checklist

Everything between here and both stores. Grouped by what blocks what, not
by store — several items gate others, and two of them cost calendar time
rather than work.

Status as of 2026-09-28. Tick items as they land; add a date when you do,
so a stale "done" is visible.

## Start these first — they cost waiting, not doing

- [ ] **Play closed test: 12 testers, 14 continuous days.** Personal Play
      accounts created after 2023-11-13 can't reach production without it.
      Testers must accept, install *and actually open* the app — Google
      checks engagement now, and rejects a test where nobody used it.
      Two weeks minimum, so start it the day the build is installable.
      ([rules](https://support.google.com/googleplay/android-developer/answer/14151465))
- [ ] **Apple Developer Program** — $99/year, and the Apple ID takes a day
      or two to clear.
- [ ] **Google Play Console** — $25 once.
- [ ] **BIS notification email.** One message, no reply expected, to
      `crypt@bis.doc.gov` and `enc@nsa.gov` with the GitHub URL. Publicly
      available encryption source is not subject to the EAR once notified
      (§742.15(b)), and the compiled binary follows under §740.13(e) — so
      this replaces the annual CSV report. **Only holds while the repo is
      public.** Keep a copy of the sent mail.

## Production environment

Prod is 852138521113, staging 223057859233. See
[INFRASTRUCTURE.md](INFRASTRUCTURE.md).

- [x] AWS account for prod, `mimoza-prod-admin` IAM user, and two local
      profiles: `mimoza-prod-admin` via `aws login`, and `mimoza-prod-tf`
      with static keys because Terraform can't read a `login_session` one.
- [ ] Root MFA, and Activate IAM Access so the billing pages open to an
      IAM user at all.
- [x] Alarm email confirmed in both accounts, and delivery tested by
      publishing to each topic. The listing lies while a confirmation is
      pending, so publish rather than trust it.
- [x] `server/provision/envs/prod` applied, with the wildcard certificate
      validated and `api.` and `cdn.` resolving.
- [x] Apple keys in SSM. The APNs key is team-wide and serves both envs,
      so prod reuses staging's — what differs is `APNS_TOPIC`. The Sign in
      with Apple key does not: it belongs to a primary App ID, so prod has
      its own.
- [x] FCM key in SSM, from the prod Firebase project (`mimozaapp-1587f`).
- [x] Google OAuth clients for the prod bundle id — they already existed,
      since dev shares production's bundle id and had been using them. No
      Apple Services ID: that's for web and Android Apple sign-in, and a
      native app authenticates as its bundle id.
- [x] `.env.production` locally: `APP_ENV=production`, relay URL, three
      Google client IDs.
- [x] GitHub `production` environment (role ARN, account id, domain,
      alert email) + OIDC role. The workflow's prod job already exists,
      on `server-v*` tags — commit 5680ce9.

## App build

- [x] `aps-environment` production-only for `APP_ENV=production` — commit
      a356a70.
- [x] `ITSAppUsesNonExemptEncryption: true` — the app carries its own
      ciphers, so the HTTPS exemption doesn't apply.
- [x] `ios.buildNumber` and `android.versionCode` set, both `1` —
      2026-09-28. Still open: whether CI bumps them or you do. Each store
      rejects a repeat upload of the same number.
- [x] `RECORD_AUDIO` dropped — 2026-09-28. `expo-image-picker` ships a
      config plugin Expo applies even when it isn't listed, and its default
      adds the microphone. `microphonePermission: false` in `app.json`
      removes it and blocks any other package from adding it back. What
      remains: `CAMERA` (device-transfer QR), `INTERNET`, and the legacy
      storage pair capped at API 32.
- [ ] `npx expo prebuild --clean` before either release build. `android/`
      is gitignored and the one on disk predates the permission change.
- [ ] Play upload key generated and backed up somewhere you'd still have
      after losing the laptop. Losing it means a new listing.
- [ ] Verify Play's target API floor at submission — it moves every
      August. Expo 57 resolves to `targetSdk 36`, which clears the 2025
      floor.
- [ ] Build both stores' release artifacts and install them from
      TestFlight / internal testing, not from Xcode.

## Review blockers

- [ ] **Guideline 1.2 / Play UGC policy: a report path.** Photos shared
      between people trigger it on both stores. Removing a member and
      leaving a circle cover "block"; the "Report a problem" row in
      settings is the "report" half. It exists in the working tree with a
      fallback for a device with no mail app (alert + copy the address),
      but is not committed — land it. Then tap it on a simulator with no
      mail account, which is what a reviewer's device looks like.
- [ ] **Review notes, both stores.** Apple's "App Review Information" and
      Play's "App access" section. Sign-in is Google or Apple only, so
      there is no demo account to hand over — say that any account works,
      and walk them fresh account → create a circle → post a photo.
      Confirmed solo-reachable, so no invite and no second device — say it
      explicitly, because "we were unable to complete the review" is the
      default outcome when an invite looks required.
- [ ] Say in the same notes that content is end-to-end encrypted, so the
      relay can't inspect anything and a report is submitted from the
      reporting device.
- [ ] Consider a standing invite link in the notes anyway, so a reviewer
      can see the multi-person case without a second device.

## Store listings

- [ ] **The website.** `joinmimoza.com` still has no DNS records — checked
      2026-09-28, nothing resolves. The privacy page is built and committed
      (38c0447) but unreachable, and the in-app link points at it. One
      deploy covers the three items below; they are one piece of work.
- [ ] Privacy policy URL, live. Required by both, and the App Privacy /
      Data safety answers must match it.
- [ ] Support URL (Apple requires a URL, Play takes an email) — the same
      host.
- [ ] **Play account deletion URL**: a *web* page where someone can
      request deletion without installing the app, declared in Data
      safety. The mailto paragraph inside the privacy policy is not one.
      Add a page beside `privacy/` in `landing/vite.config.ts`'s inputs.
- [ ] App Privacy (Apple) and Data safety (Play): account identifier from
      Apple/Google, push token. Content is E2EE and unreadable by you —
      state it, it's the product.
- [ ] Age rating questionnaires — IARC for Play, Apple's own.
- [ ] Availability: every territory on both stores. Apple defaults to all;
      Play makes you tick them ("add all countries"). The listing stays
      English everywhere, like Threads' Turkish page does — the store
      falls back to the primary localization, and the "Languages" line
      comes from the binary, which already says Turkish.
- [x] Listing copy, English, in `app/fastlane/metadata/` (App Store) and
      `app/fastlane/metadata/android/` (Play) — 2026-09-28. Uploaded by
      `fastlane ios listing` and `fastlane android listing`; the review
      notes are `metadata/review_information/notes.txt`. Category is
      Social Networking, Photo & Video second, on both. Other markets are
      a copy of the `en-US` folder under the store's locale code; the app
      ships tr/es/fr/de, and localized listings are optional.

## Screenshots

Both stores, same shot list in the same order.

- [ ] **Capture from a production-config build.** `EnvBadge` draws a
      STAGING/DEV ribbon in the bottom-left of every screen unless
      `APP_ENV=production`, and it is deliberately always in frame.
- [ ] Staged content only. These get indexed; no real people's photos, no
      real names. `npm run seed:screenshots` (2026-09-29) builds three
      fixture circles — fake people, photos, captions, comments, reactions,
      all committed in `app/scripts/seed/fixtures/screenshots.json` — against
      a local testrelay, then waits for your own account to request to join
      each one (prints the `mimoza://join/<code>` links) and approves it.
      Needs `TESTRELAY_RESOURCE_PREFIX` set when starting testrelay, so a
      reseed never touches the integration suite's own tables:
      `TESTRELAY_RESOURCE_PREFIX=screenshots go run ./cmd/testrelay`, then
      `SEED_RELAY_URL=http://127.0.0.1:8099 npm run seed:screenshots` from
      `app/`. Re-running deletes each circle it made last time first.
- [ ] Clean status bar. iOS simulator: `xcrun simctl status_bar booted
      override --time 9:41 --batteryState charged --batteryLevel 100
      --cellularBars 4 --wifiBars 3`. Android emulator: `adb shell settings
      put global sysui_demo_allowed 1`, then `adb shell am broadcast -a
      com.android.systemui.demo -e command enter` and `... -e command
      clock -e hhmm 0941`.
- [ ] Shot list, portrait:
      1. Circle list (`circle/index`): two or three circles, an unread
         badge, the Encrypted pill in the header.
      2. A circle feed (`circle/feed`): photos with captions, a reaction,
         a comment preview.
      3. Post detail (`post/[id]`): comments and reactions.
      4. Album grid (`circle/album`).
      5. Inviting: `circle/new` or the join sheet with an invite code.
      6. Account (`account`) with the privacy notice open — the E2EE
         story in one frame.
      Leave the sign-in screen out, or last; Apple reads a login wall as
      the first shot as "nothing to see".

**Apple (App Store Connect)**

- [ ] iPhone only: `ios.supportsTablet` is unset, so no iPad set is asked
      for.
- [ ] 6.9" iPhone: 1320 × 2868 px portrait (1290 × 2796 is also accepted
      in that slot). App Store Connect scales it for smaller iPhones, so
      one set covers all. Capture on the latest Pro Max simulator.
- [ ] 1 to 10 per localization. PNG or JPEG, RGB, no alpha.
- [ ] App preview video optional, 15 to 30 s, same resolution.
- [ ] Icon comes from the build's asset catalog; nothing to upload.

**Google Play**

- [ ] Phone screenshots: 2 to 8. PNG or JPEG, each side 320 to 3840 px,
      long side at most twice the short. A raw phone capture is taller
      than 2:1 and gets rejected, so these are composed: the 1080 × 1920
      templates in the Figma file "Mimoza store screenshots" take the
      same 1320 × 2868 capture as the App Store set.
- [ ] Feature graphic: 1024 × 500 PNG or JPEG, required. No transparency,
      nothing important near the edges — it's cropped in some placements.
- [ ] App icon: 512 × 512 PNG, under 1 MB, from the same source as the
      adaptive icon.
- [ ] 7" and 10" tablet shots are optional. The app isn't restricted from
      tablets, so the console warns without one set; it doesn't block.
- [ ] Promo video optional, a YouTube URL.

## Already done

- [x] Sign in with Apple — required by 4.8 because Google sign-in exists.
- [x] In-app account deletion, and it erases relay-side content.
- [x] Photo and camera permission strings, specific about why.
- [x] Push permission asked in context, not at launch.
- [x] Staging environment end to end: relay, CDN, alarms, CI/CD.
- [x] Android photo access goes through the system photo picker; no broad
      media permission on API 33+.
