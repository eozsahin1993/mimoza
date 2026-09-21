# Mobile push design

Status: **built on both platforms.** Android: FCM data messages composed
by the on-device JS handler. iOS: real APNs alert pushes
(`internal/push/apns`) rewritten by a native Notification Service
Extension (`app/targets/MimozaNotificationService`) that reads the shared
App Group keychain and a circle/member-name snapshot
(`app/src/features/push-notifications/usecases/push-snapshot.ts`).

Supersedes `DESIGN.md` section 2, which reached the same broad shape
(routing IDs, device-side composition) but left the decisive question —
whether the fanout call is authenticated — unspecified, and assumed a
`routingId → pushToken` table whose stated shape contradicted itself. Read
that section for the original reasoning; this document is what to build.

## The problem

Show "Sarah commented on your photo" without the relay learning the circle
name, who is in it, or what was said. Push is table stakes for adoption,
so "don't do notifications" is not an answer.

Three constraints make it awkward, and every design decision below falls
out of one of them:

1. **The relay cannot read circle content.** So it cannot compose
   notification text, and cannot classify what happened.
2. **iOS cannot suppress a delivered notification.** Once an alert push
   arrives, a card appears. The Notification Service Extension can rewrite
   it but not cancel it. So recipients cannot filter on arrival — filtering
   has to happen before delivery.
3. **Devices cannot reach APNs/FCM themselves.** Only the relay can, which
   is why it has to be told who to deliver to at all.

## Identifiers

All derived client-side, all domain-separated the same way as everything
in `app/src/core/crypto/`:

```
routingId   = HKDF(masterSeed,          "push-enabled" || circleId)
deviceId    = HKDF(deviceSecret,        "push-device"  || routingId)
fanoutToken = HKDF(contentKey[current], "push-fanout")
```

The routing domain is `"push-enabled"`, not the `"push-routing"` this
document originally specified. Every shipped device and relay row already
uses it, so the name is what's wrong, not the string.

`deviceSecret` is 32 random bytes generated once per device and kept in
SecureStore.

**`routingId` is per person, per circle.** Derived from the seed, so every
device you own computes the same one — which is what makes notification
preferences account-wide with nothing to sync. Derived rather than random
(what `DESIGN.md` section 2 specified) so a new phone recomputes it
instead of re-registering, and so a device transfer needs to carry
nothing.

Deriving it from `accountId` instead would be fatal: the relay knows your
`accountId` from the session and sees `syncId` on every append, so it could
compute every routing ID itself. The seed is the one input the relay can
never have.

**`deviceId` is per device, per routing ID.** A single device-wide
identifier reused across circles would let the relay group your routing
IDs straight out of the sort key — the same clustering the routing IDs
exist to prevent, reintroduced through a table key. The `deviceSecret`
never leaves the device, so the derived values are unlinkable without it.

**`fanoutToken` is per circle, and rotates.** It is never stored and never
published: every member derives it from the content key they already hold.
Because it derives from the *current* content key, removing a member
rotates it, and their push capability dies with the rotation that already
happens. `routingId` deliberately does not rotate — binding it to
`keyVersion` too would force a roster update on every removal, for no gain.

## Storage

One DynamoDB table, two sort-key shapes, the same pattern `invitestore`
already uses:

```
pk = routingId
sk = "prefs"             -> { pushFanoutHash, categoryMask, keyVersion, silenced }
sk = "device#<deviceId>" -> { pushToken, platform, enabled }

pushFanoutHash = sha256(fanoutToken || routingId)
```

**The hash is salted by `routingId` on purpose.** Storing the bare
`hash(fanoutToken)` would put an identical value on every row in a circle,
and the relay could cluster membership straight out of the table — the one
thing this design is meant to keep out of durable storage. Salting per row
makes each value unique while verification still works, since the relay
knows which routing ID it is checking.

**Deliberately absent: `accountId`, `circleId`, `syncId`, and any list of
which routing IDs belong together.** Registration requires a session but
writes no account link — and, unlike the circle routes, consumes no
per-account budget. Nothing else needs one: knowing a
`routingId` is itself the authorization to manage that row, since only the
seed produces it.

Push tokens are **not** encrypted at rest beyond DynamoDB's own SSE. The
client base64s the platform token and the relay stores those bytes as it
received them (`putPushDevice` in `services/relay.ts`, `PutDevice` in
`push/dynamodb`) — it has to hand APNs and FCM the token verbatim, so an
application-layer key it also holds would buy nothing. Encrypting under a
key the relay can't use would mean it couldn't send.

## The flow

**Register** — on every launch, and again when a circle's feed is first
opened (`enablePushEverywhere`, `askForPushOnCircle`), since a push token
rotates and the fanout hash follows the content key. Joining a circle only
creates its Android channel; registration happens on the next of those. Authenticated,
`accountId` not persisted:

- `PUT /v1/push/{routingId}` with `{ pushFanoutHash, categories, keyVersion }`
- `PUT /v1/push/{routingId}/devices/{deviceId}` with `{ pushToken, platform, enabled }`

`PUT /v1/push/{routingId}/silenced` exists on the relay as the
delete-nothing way to mute a circle, but no client calls it — see
"Categories" below.

`DELETE` on either undoes it — the device row for this device alone, the
routing row for the whole circle.

**Publish** — `routingId` rides in the member's roster entry, encrypted,
syncing through the log like every other roster field. The relay never
sees a circle-to-routing-ID map.

**Send** — after `appendEntry` succeeds, unauthenticated:

- `POST /v1/push/send` with
  `{ pushRoutingIds[], pushFanoutToken, category, keyVersion, payload }`
- routing IDs come from the sender's own decrypted roster, minus their
  own, and are shuffled — roster order is stable, so sending in it would
  leak the ordering across posts
- `payload` is the entry's existing ciphertext, nothing else. The
  placeholder is the relay's own constant (`push.Placeholder`), stapled
  on at dispatch; a sender cannot choose it

**Verify** — per routing ID, the relay recomputes
`hash(fanoutToken || routingId)` and compares against that row. A mismatch
is skipped silently. This is a shared-secret comparison, not a signature:
there is no key here the relay could verify against — an entry's author
signature is inside the ciphertext, and is checked client-side on replay
by `verifyLogEntry` (`app/src/core/sync/log-entry.ts`), which every
handler runs before `authoredByMember` decides whether that author was
ever a member. (The relay does verify signatures elsewhere, for
write authority — `synclog/capability.go`. Just not for push.)

The salted hash is what stops a member of circle A targeting circle B's
routing IDs: they cannot produce B's token. A plain `writeToken` + `syncId`
check would *not* have worked here — the relay has no stored mapping to
tell whether a supplied routing ID belongs to the circle being claimed, and
accepting `syncId` would hand it the circle-to-routing-ID binding this
design exists to withhold.

**Deliver** — check the category bit, then dispatch to each `enabled`
token individually rather than as one grouped send. Each delivered push
carries only that recipient's own `routingId` (plus `keyVersion` and the
ciphertext) — the full `routingIds[]` list exists only in the send
request, so no member ever sees another member's routing id, and nothing
delivered reveals the grouping.

**Receive** — the device maps `routingId` to a circle locally, decrypts at
`keyVersion`, and composes the text itself. iOS uses a Notification Service
Extension; Android an FCM data message into an expo-notifications
background task (`services/task.ts`).

## What a delivered push contains

One log entry that skipped the line. `payload` is byte-for-byte the
`encryptedMeta` the sender appended to the sync log — same encryption,
same signature, the bytes the next sync would deliver anyway — with a
delivery address stapled on. The iOS shape (Android carries the same
three in an FCM data message, `keyVersion` as a string, plus a
`placeholder` field neither receiver reads):

```
{
  "aps": { "alert": "New activity", "mutable-content": 1 },
  "pushRoutingId": "837256bc0d92…",   ← recipient's own address, resolvable only by their seed
  "keyVersion": 3,                     ← already plaintext on every append
  "payload": "KP6zUVZg6cgu…"          ← base64: nonce(24) ‖ XChaCha20-Poly1305 box
}
```

Decrypted with the circle key at `keyVersion`, `payload` is the entry
envelope — where the actual content lives, and everything the device
needs to compose real text:

```
{
  "type": "comment",
  "payload": { "commentId": "…", "postId": "…", "body": "so cute!!", "createdAt": …, "postAuthorPubkey": "…" },
  "authorPubkey": "2fe1c922…",
  "signature": "8a41f3…"
}
```

## Why the send call is unauthenticated

Riding fanout on the authenticated append is simpler and reuses the
`writeToken` check already there. It was rejected because every fanout
would then arrive alongside an identified poster, and a few posts from
different members lets the relay solve the membership graph by elimination
— each poster's own routing ID is absent from their own fanout.

Unauthenticated, gated on a recipient-derived secret, the relay sees
anonymous clusters instead: it learns those routing IDs form a group, but
nothing says whose. This is the same shape as Signal's unidentified sender
path, which gates on a key the recipient handed out rather than on the
sender's identity.

The cost is that a former member with an old roster keeps push capability
until the next rotation, and rate limiting cannot key on an account.

## Rate limiting

`ratelimit.Store.Allow(ctx, key)` takes a key chosen by the *handler*
(not by the HTTP caller — `ratelimit.Require` passes the authenticated
accountID), so this reuses the existing store rather than new
infrastructure.

Two different things need protecting, and one limit cannot do both.
Protecting a *recipient* means keying on their `routingId`, which is
attacker-supplied. That is fine for its purpose: a random routing ID
reaches nobody, and to actually spam someone you must use their real one,
which is exactly the key — so it cannot be varied while still reaching
them. But it means an attacker cycling random IDs gets a fresh budget every
request, so it does nothing to protect the *relay*. Since there is no
session to budget against, that half is pushed out to the edge:

- **Per recipient `routingId`.** The one that matters: it bounds how much
  any individual can be pushed regardless of who is sending.
- **Cap the `routingIds[]` length per request.** A circle's membership is
  bounded, so a request targeting thousands is not a real one.
- **Raw flood protection belongs in front of the app**, not in it. Doing
  it here would mean keying on IP, which means writing IPs into our own
  table — directly against the no-logging stance below, and only
  approximately true anyway: carrier CGNAT puts thousands of users behind
  one address, families share a home network, and IPv6 needs /64 bucketing
  rather than per-address. Any limit loose enough to be safe is too loose
  to be useful.

  Note the relay is served by a Lambda Function URL
  (`provision/modules/lambda/lambda_url.tf`), not API Gateway, so there is
  no gateway throttling to configure and **WAF cannot attach to it**.
  CloudFront is now in front (`provision/modules/cdn`), but neither half
  of the answer is actually in place: no WAF is attached to the
  distribution, and `behind_cloudfront` is `false` in both environments,
  so the function URL still answers direct callers and anything attached
  to the distribution is bypassable. `reserved_concurrent_executions` is
  wired to a variable that both environments leave at `-1` — unreserved.
  Push shipped without either; both are still to do.

**Order matters: verify before consuming any budget.** Cheapest and most
selective first — the length cap (no I/O at all), then read and verify each
routing ID, and only then consume that recipient's budget for the ones that
passed. Budgeting first means an attacker cycling random routing IDs makes
the relay *write* a budget row per nonexistent target, turning the rate
limiter into the amplification.

Verification and the per-recipient budget are not redundant, because they
stop different people. Verification stops an outsider: no token, no
delivery. The budget stops an insider, who has a valid token and passes
verification every time — nothing else bounds them.

## Notification content

The device composes the real text. The payload also carries a fixed,
content-free placeholder ("New activity"), needed in two cases:

- the NSE runs but decryption fails — it substitutes a string **hardcoded
  in the extension**, never one read from the payload, so a forged push
  cannot put chosen text on a lock screen
- the NSE never runs (memory, timeout) — iOS renders the payload's own
  alert body, which is why that must be the placeholder too

Send alert pushes with `mutable-content: 1`, never silent
(`content-available`) pushes: silent pushes are budgeted, deprioritized in
Low Power Mode, and dropped after a force-quit.

An in-app "Hide details in notifications" setting should reuse the same
placeholder path. The notification text is the most sensitive plaintext in
the system and it lands on a lock screen — the relay never sees it, but a
passer-by does.

## Categories

The `category` field on the send call is a plain integer, deliberately.

Encoding it as `HKDF(circleId, type)` was considered and rejected: every
member derives the same tag, so the relay could cluster routing IDs by
matching tags — the durable grouping this design keeps out of storage. A
per-recipient derived tag avoids that but must be published in advance,
which means adding a category later requires every member to republish
their routing IDs into the roster.

The integer's meaning is not secret — anyone with the client can read it —
but the relay can already infer roughly the same thing from traffic shape:
namespace, ciphertext size, and whether a blob upload accompanied the
entry. Opaque names (`option1`) are fine if wanted, but they are cosmetic:
the design must be correct assuming the mapping is public.

Categories live on the `prefs` row, so they are account-wide. Per device,
there is an `enabled` flag on the device row, but nothing writes `false`
to it — turning one device off deletes that device's row instead
(`unregisterDeviceForCircle`), which is also what signing out does.
"Silence this circle" deletes the whole routing row, prefs and devices
together; nothing needs to sync, and no log entry is written. The relay
also carries a `silenced` flag and a `PUT …/silenced` route for muting
without discarding the row, which no client uses yet — deciding between
them is open.

## Levels, and Android channels

The relay stores a category bitmask per routing id and knows nothing about
what the bits mean. The client presents them as a **ladder** rather than
independent switches — new photos, then comments, then reactions — because
nobody wants reactions but not photos, and one choice beats four toggles.

**Someone joining is in every level**, not the top rung. It is a security
event rather than a social one: a new member can see every photo already in
the circle, only the invite's creator saw the approval screen, and the name
and picture on it were supplied by the requester. Telling everyone else is
how another member gets to say "wait, who is that?". It is rare enough to
cost nothing in volume. Silencing the circle covers it; nothing else does.

**Reactions are where the default stops.** One photo in a six-person family
can draw five of them, and none say anything a comment doesn't. Easier to
turn notifications up than to win back someone who switched them off.

A level is stored as the mask it expands to, not by name, so an unfamiliar
combination from another device survives being read back — `levelForMask`
rounds *down* to the nearest level whose categories are a subset, so an
unknown mask reads as quieter than it is rather than louder.

### Channels and groups

Built, except the shade grouping below: `services/channels.ts` creates one
channel per circle under one shared group, and removes a circle's channel
when it's left.

**One notification channel per circle**, created on join. That is what gives
Android users per-circle sound, vibration and enable/disable in system
settings, which is where they will look — the shape WhatsApp uses per
conversation.

A channel's sound, vibration and importance are frozen once created. Its
**name and description are not**, so re-calling `createNotificationChannel`
with the same id is how a renamed circle keeps a correct label — which is
why the id is a plain `circle-<id>`.

Offering a tone picker *in the app* would break that: a new sound needs a
new channel, so the id would have to carry the sound
(`circle-<id>-<soundHash>`), and Android remembers deleted channel ids.
Android's own settings already offer a per-channel sound, so the id stays
plain until we decide the in-app version is worth that.

Three Android mechanisms, easy to conflate, all keyed `circle-<id>`:

- **Channel** — owns sound, vibration, importance. One per circle.
- **Channel group** (`createNotificationChannelGroup`) — organises channels
  in *system settings*. **One shared group**, not one per circle: with a
  single channel each, a group per circle would render as a heading per
  circle with one meaningless child under it. Shared, it reads as "Circles"
  with a row per circle. A group each only earns its place once a circle has
  several channels — per category, say. Note deleting a group deletes its
  channels, so leaving a circle drops that circle's *channel*, never the
  group.
- **Notification group** (`setGroup` on a posted notification) — bundles a
  circle's notifications in the *shade*, so several photos collapse into one
  stack with a summary rather than five rows. Not built: `services/task.ts`
  schedules each notification on its own.

**The two silences differ, and the UI must not pretend otherwise.** The
in-app toggle stops *delivery* — the relay has no row to send to. Disabling
the channel stops *display*; the push still arrives. They drift apart the
moment someone uses system settings, so on Android the in-app row should
read the channel's enabled state and reflect it.

iOS has no channel concept, and nothing on that side sets a sound at all
— the APNs payload omits the key and the extension doesn't add one, so
cards arrive silently. It groups them instead, by setting
`threadIdentifier` to the circle id.

## What this leaks, honestly

**At rest, nothing that groups anyone.** A stolen table yields opaque
routing IDs, push tokens (stored as received — see above), salted hashes,
and category bits. No
accounts, no circles, no graph.

**In flight, the grouping.** A send call carries a set of routing IDs, and
that set *is* the relationship. This is structural: the relay cannot fan
out to a group it has not been told about, and devices cannot reach
APNs/FCM themselves.

Splitting the send into one request per recipient removes the explicit set
but not the inference — N requests from one address within a second is a
group. Defeating that needs jitter (which delays notifications), an
unlinkable transport (which needs a proxy run by someone else), and enough
volume to hide in (which a small private relay does not have). Signal ends
up in the same place and answers it with policy rather than cryptography.

**So the claim to make is "nothing durable is written down," not "the relay
cannot tell."** The first is true and defensible. The second is not, and
`DESIGN.md` section 2 reads as though it were.

For the policy half to be real, source IPs must actually not be logged —
API Gateway access logs, CloudFront, and ALB logs all capture them by
default. Retention on whatever remains should be short.

## How it was built (all landed)

- iOS Notification Service Extension:
  `app/targets/MimozaNotificationService`, a Swift target injected by the
  `@bacons/apple-targets` config plugin. The crypto port
  (XChaCha20-Poly1305 via swift-sodium; HKDF and Ed25519 via CryptoKit) is
  pinned against the JS side by
  `app/src/core/crypto/__tests__/push-crypto-vectors.test.ts`.
- The App Group doubles as the shared Keychain access group and the shared
  container. It carries the bundle id, so it differs per environment
  (`group.com.eozsahin.mimoza`, `.staging`) — staging sharing prod's group
  would mean each reading the other's seed. `core/services/keystore/store.ts`
  writes every secret there with `keychainAccessible: AFTER_FIRST_UNLOCK`
  — the default `WHEN_UNLOCKED` is unreadable from an extension on a
  locked phone — and migrates pre-App-Group items on first read.
- The extension can't open the app's SQLite file, so circle and member
  names reach it through a JSON snapshot in the shared container,
  refreshed on launch and after every sync pass, and deleted on sign-out
  (`push-snapshot.ts`). It carries the in-app language too, which the
  extension can't read from AsyncStorage. Stale is benign: the card says
  "Someone".
- Android: an FCM data-message path into the JS background task.
- APNs auth key and FCM service account credentials on the relay, SSM
  SecureStrings created by hand under the AWS-managed `aws/ssm` key (this
  project has no KMS key of its own — see DESIGN.md). These are the most
  dangerous secret the relay will ever hold — anyone with them can put
  arbitrary text on users' lock screens, bypassing the extension entirely
  by omitting `mutable-content`.
