# Invite flow

Status: **built**, all 7 steps below — `app/src/features/invite/usecases/join-circle.ts`
(requester side), `invite-to-circle.ts`'s `discoverPendingRequests`/`approveJoinRequest`
(creator side), `app/src/app/join/[code].tsx`/`join/pending.tsx` (deep-link
handling and UI), and `server/internal/invite` +
`server/internal/invite/http` (the server-side table and routes this doc
calls the "mailbox"). One addition beyond what this doc originally
specified: the approval is also signed by the approver's own circle
identity and verified by the requester against `createdByPublicKey` (now
carried in the invite preview) — without it, any existing member who knew
the invite code and the circle's content key could forge a valid-looking
approval, not just this invite's actual creator. The pull side is built
too: a joined circle row starts at cursor 0 and `pullMeta`/`pullContent`
(`app/src/core/sync/pull-log.ts`) replay its history from epoch 0. This
doc captures the full design worked out for it, refining DESIGN.md's
"Invites" and "Mailbox" sections (3) into a concrete mechanism for this
one specific use of the mailbox concept. Read
[server/README.md](../server/README.md)'s "Identity model" section first:
a circle's relay address is a random `syncId` minted at creation
(`create-circle.ts`), which that section now describes.

## Goals and constraints

- The relay never learns a circle's name, its membership, or who's
  inviting whom — same blind-relay property as everything else in this
  system. Not structural, though: every `/invites/` route is behind
  `auth.RequireSession`, so account and invite tag are both present in
  the same request. What keeps them uncorrelated is that neither the
  rows nor the request log ever pair them — `httputil.LogRequests`
  records the route pattern, never the path.
- An invite code has **uncapped redemptions** (DESIGN.md's "Invites"
  section) — the same code can be shared in a group chat and used by
  several different people, not just once.
- Every join requires **explicit approval by the invite's specific
  creator** — never "any admin," never automatic.
- **No dependency on push notifications working, in either direction.**
  Push is built, but neither direction of this handshake is wired to it:
  the only join-related notification is `member_added`, which reaches
  existing members after the fact. It could still accelerate both — notify
  the creator sooner that a request arrived, notify the requester sooner
  that they were approved — but manual/opportunistic sync must
  independently work end to end regardless of whether push ever fires,
  whether the platform delivers it, or whether the user has notifications
  disabled entirely. Same principle as the general push design: push is
  an enhancement layered on top, never the delivery mechanism itself.

## The two encryption schemes — don't conflate them

This flow uses two structurally different mechanisms depending on the
step. Mixing them up is the easiest way to get this wrong.

1. **Symmetric, code-derived** — used for the invite preview and the join
   request. The invite code itself has real entropy (60 bits) and can
   double as shared key material: `HKDF(invite_code, "<purpose>")`
   produces a key that **both the creator and the requester can compute
   independently**, just by knowing the code — no exchange needed. HKDF
   itself doesn't encrypt anything; it derives a key, which then feeds
   the same `encrypt()`/`decrypt()` (XChaCha20-Poly1305 AEAD) already used
   for circle content.
   - Anyone who has the invite code can decrypt anything encrypted this
     way — including, notably, *other* people who redeemed the same
     code. That's an accepted, minor leak ("who else is in the invite's
     waiting room"), not a security bypass — see below.
2. **Asymmetric, one-time keypair, sealed-box style** — used only for the
   approval response, the one payload that must be readable by exactly
   one person. The requester generates a fresh keypair just for this
   handshake and includes the public half in their join request. The
   creator, replying, generates *its own* fresh one-time keypair for this
   one message, uses it (via ECDH against the requester's public key) to
   encrypt the payload, and prepends its own ephemeral public key to the
   response. The requester needs only its own private key (already has
   it) plus what comes back to decrypt — it
   never needs to know any public key belonging to the creator in
   advance. No pre-shared creator identity is required anywhere in this
   flow.

## Storage: one table, two sort-key shapes

Reuses the generic "mailbox" idea from DESIGN.md section 3 (ephemeral,
tag-addressed, not circle content) but with a concrete shape for this use:

```
pk = sha256("invite-tag" || invite_code)   -- hex, the relay-visible tag
sk = "invite"              -- one per invite, written once at creation
sk = "request#<requesterId>"  -- one per requester, created by the requester
```

- **`sk = "invite"`**: written by the creator at invite-creation time —
  the one proactive server write in this whole flow. Contents: the
  circle's current name, the creator's own display name and avatar
  thumbnail (`createdByName`/`createdByPicture`, self-reported and
  validated on the way out like any other picture crossing a trust
  boundary), and the creator's circle-identity public key
  (`createdByPublicKey` — see the approval-signing note above), encrypted
  with `HKDF(invite_code, "invite-preview")`. This is the trade-off
  explicitly made in this design: invite creation is no longer purely
  local, and the relay learns "this tag exists" before anyone's used it —
  accepted in exchange for letting a tapped link show "You're about to
  join: Family Circle" before the person commits to anything, rather than
  a blind join. A cover-photo thumbnail was considered for this row but
  deliberately dropped — deferred until circle-level "current state"
  (name/photo as of now, not as of invite-creation) has a real design,
  rather than bolting a one-off snapshot onto this payload ahead of that.
- **`sk = "request#<requesterId>"`**: created by the requester (their own
  randomly-chosen id, no coordination needed), containing the one-time
  `ephemeralPublicKey`, the requester's *durable* identity, sealing and
  authority public keys (the last with a proof of possession), its push
  routing id, and a self-reported name and avatar thumbnail — all
  encrypted with `HKDF(invite_code, "join-request")`. The durable halves
  travel here because only an admin may write `member_added`, so the
  approver is the one who has to name the joiner. Later **updated in
  place** by the creator — not replaced with a new entry — adding the
  sealed-box-encrypted `{keyMap, syncId, circleName}` once approved. The
  creator queries `sk begins_with "request#"` to list every
  pending request under one invite at once (naturally handling multiple
  simultaneous redemptions of the same code); each requester only ever
  polls the one row whose id it chose itself, so there's no ambiguity
  about which response is its own even with several requests in flight.

TTL backstop: every row, invite and request alike, is written with an
`expiresAt` 7 days out and evicted by DynamoDB's own TTL
(`DefaultInviteRetentionDays`, matching the client's `INVITE_TTL_MS`).
Approving deliberately doesn't extend it. A request the creator dismisses,
or the requester withdraws, is deleted outright rather than left to age
out.

## The flow, step by step

1. **Create.** Creator generates the invite code (`generateInviteCode()`,
   already built) and writes the local `circleInvites` row (already
   built — code, circleId, createdByPublicKey, expiry). Additionally
   writes the server-side `sk = "invite"` row: the preview payload above,
   encrypted with the code-derived preview key. Admin-only, like every
   other invite action here.
2. **Share.** The bare code goes out via QR, the native share sheet, or
   read aloud — see DESIGN.md's "one secret, multiple presentations"
   note. Nothing else needs to travel with it; the creator's identity
   never needs to be embedded in the link at all (see the encryption
   section above).
3. **Tap.** `mimoza://join/<code>` routes to `app/join/[code].tsx`, which
   parks the code and hands it to the circle list; the join sheet opens
   over that. It fetches `sk = "invite"` for `pk = hash(code)`, decrypts
   with the preview key, and shows "<creator> invited you to <name>."
4. **Request.** Device generates a one-time keypair, writes `sk =
   "request#<ownRandomId>"` with the payload described above, encrypted
   with the join-request key. Locally, records this as a
   pending request in `pendingJoinRequests` (invite code, the `circleId`
   minted here, circle name and creator details from the preview,
   submitted-at, status), so a "pending for Family Circle" screen
   survives the app being closed and reopened before approval ever lands.
   The keypair's secret half goes to the Keychain, not that row. Reopening
   the same link reuses the outstanding request rather than stacking a
   second one.
5. **Discover.** Creator's device checks `sk begins_with "request#"`
   under the invite it created — whenever that circle's feed is opened or
   pulled to refresh, never dependent on push arriving. Decrypts each with
   the join-request key to read the self-reported name for the approval
   screen, skipping rows that already carry an approval. Per DESIGN.md:
   that name is **not verified identity**, just "someone used the invite
   you created."
6. **Approve.** Creator catches up on meta first — a stale approver would
   hand over an incomplete key map — then signs `{keyMap, syncId,
   circleName}` with its own circle-identity secret key (the same keypair
   every post is already signed with), and updates that same row with a
   sealed-box payload: the signed envelope, encrypted to the requester's
   `ephemeralPub`. `keyMap` is every version this device holds, not just
   the current one, so the joiner can read history predating its join. The
   approver also writes the `member_added` entry, naming the joiner from
   the public keys in the request. Signing wasn't in the original design
   here: without it, anyone who knew the invite code and the circle's
   content key — any existing member, not just this invite's creator —
   could forge an equally valid-looking approval, since the seal alone
   only proves "sent to the right requester," not "sent by the right
   person."
7. **Complete.** Requester polls its own pending-request row — same
   app-lifecycle-triggered polling as step 5, never dependent on a push
   telling it "you've been approved" — decrypts with its own ephemeral
   private key once the secret field appears, gets the signed envelope,
   and verifies the signature against the `createdByPublicKey` it
   captured from the preview back in step 3. A signature that doesn't
   verify is treated exactly like no approval having arrived yet, not a
   fatal error — the pending row is left in place either way, so a later,
   legitimate approval can still land and succeed. Once verified, saves
   the key map and its own circle identity to the Keychain before any
   local write, same order as `createCircle`. Both go under the `circleId`
   minted back at step 4, not a fresh one: the identity the approver
   already vouched for was derived from it. The relay address isn't
   derived from anything — `syncId` arrives in the approval. From there
   the circle row starts at cursor 0 and ordinary sync replays its history
   from epoch 0.

## What this flow used to depend on

Everything below is built — kept as a record of what once gated this
flow, not a current TODO list:

- ~~The pull side (`pullCircle`)~~ — built, under other names:
  `pullMeta`/`pullContent` walk each namespace from the circle's cursor,
  and a freshly-joined circle row starts at 0, so a joiner replays the
  whole history rather than landing on an empty feed. The "content will
  sync soon" banner survives for the gap between joining and the first
  pass landing — `just-joined-row.tsx` hides it as soon as a post exists.
- ~~A `member_added`-equivalent log entry type~~ — built. `outbox.entryType`
  includes `'member_added'`, and `invite-to-circle.ts`'s
  `approveJoinRequest` enqueues it — the *approver*, not the joiner, since
  only an admin may write one and nobody would have vouched for an entry
  the joiner signed itself. It's also applied locally on both sides so
  neither roster waits for a sync pass.
- ~~Deep-link handling~~ — built. `mimoza://join/<code>` auto-routes to
  `app/src/app/join/[code].tsx` via Expo Router's file-based routing and
  `app.json`'s existing `"scheme": "mimoza"` — no manual `Linking` code
  needed. A tap before sign-in/profile-setup is complete is handled too
  (`app/src/features/invite/services/pending-invite.ts` remembers the code
  and resumes the flow once onboarding finishes).
- ~~The local `pendingJoinRequests` table~~ — built (`app/src/data/db/schema.ts`).

## Open questions not resolved in this doc

- What *should* happen to a `request#` row if its invite is revoked or
  expires while the request is still pending, still isn't decided. What
  happens today: revocation is local only (`revokeInvite` sets
  `revokedAt` in SQLite), so the preview row stays fetchable and requests
  can still be submitted against the old code — they just stop being
  discoverable, since `discoverPendingRequests` only ever looks at the
  circle's current invite. The requester waits until TTL evicts the row,
  and only then is told the request is gone.
- ~~Whether a circle rename after someone's already joined needs its own
  log entry type~~ — it does, and `circle_renamed` exists. Still
  orthogonal to this flow: a joiner gets the name as of the moment they
  joined, and the rename entry is what corrects it afterwards.
