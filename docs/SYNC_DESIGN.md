# Sync & key management design

Status: **built**, with one exception: the discovery table in §8. Recovery
still runs off the account-keyed manifest (`internal/account`), so every
claim below about `discoveryId` is design, not code. Supersedes
`DESIGN.md` section 1's TTL-based framing wherever they conflict
(`DESIGN.md` not yet updated).

Read order: **invariants** (the rules that must never be negotiated away),
then **operations** (the spine), then **extending this design** (how to add
things without re-architecting). Rationale is at the end.

---

## Invariants

These are load-bearing. A feature that requires breaking one is a signal
the architecture is wrong for it — not a signal to bend the rule.

1. **The log is append-only. A payload is never rewritten.** Signatures
   cover the payload (rewriting makes an entry permanently unverifiable),
   replay must be deterministic (a device that synced yesterday must hold
   the same entry as one syncing today), and that is what makes "once you
   have entry E you have it correctly forever" true — no invalidation, no
   re-fetch, no staleness.

   **Deletion removes rather than edits, and it is the only exception.**
   A tombstone is appended, and the relay then *strips* the target's
   ciphertext: `deleteentry` for one post, `deleteauthorcontent` for
   everything one identity wrote, `deletecircle` for the whole content
   namespace. Stripped rows survive with a `deletedAt` stamp rather than
   vanishing, because comments and reactions reference an entry by id;
   clients skip them as an expected absence instead of a decrypt failure.
   Nothing partially rewrites a payload, so two devices still agree on
   every entry either of them can still read.

   **Deleting a circle ends the log** rather than editing it: a
   `circle_deleted` tombstone goes to meta, every content entry is swept,
   and the circle takes no further writes. Meta outlives the sweep on
   purpose — handlers resolve an author against the roster, the roster is
   built from meta, and a device syncing from epoch 0 into a swept meta
   would have nothing to verify the tombstone against. Not forever,
   though: `expireMeta` stamps a 90-day TTL on every meta row, tombstone
   included, on the bet that anything that could still act on it has
   synced by then.
2. **Mutability is exactly three-tiered**, and it follows the plane split:

   | | mutability |
   |---|---|
   | data plane (log entries) | **append-only**; a payload is strippable by deletion, never edited |
   | control plane (`#control`) | mutable current state |
   | blob store | a post photo is write-once (first upload wins); the cover overwrites; both deletable |

   A blob goes only on an explicit request, but not always one naming the
   blob itself: `deleteblob` takes the uploader's or an admin's signature
   for that exact entry, and `deleteentry`, `deleteauthorcontent` and
   `deletecircle` each take the blobs belonging to what they strip, in the
   same call (`internal/synclog/http/deleteentry/service.go`). Nothing
   sweeps blobs on a timer. That does not soften the row above
   it: the entries naming a deleted blob stay, so replay still converges.
   Bytes are the part that carries storage cost and any obligation to
   actually destroy content.

3. **The relay enforces possession, never identity.** It is blind; it can
   check "you hold the current capability," never "you are an admin."
4. **Clients enforce identity and role**, verified cryptographically
   against their own replayed state.
5. **Default-deny.** Unknown entry type, bad signature, failed predicate,
   type-in-wrong-namespace → discard. Never accept because unrecognized.
6. **Everything shared is derivable from (seed + log).** Anything a
   recovering device must see again belongs in the log or the manifest;
   device-only state is by definition unrecoverable, so it is only ever
   acceptable for a preference the device can pick a default for. Today's
   exceptions are exactly that: a circle's push mask and silence flag
   (reset to the default on restore), `lastViewedAt` unread marks, and the
   invite codes this device issued — see "Open issues".
7. **Projections are disposable.** Every table that projects the log must
   be rebuildable by replay; the log is the only truth. The exceptions are
   the tables that aren't projections — the outbox, `circle_invites`,
   `pending_join_requests` — which hold this device's own in-flight work.
8. **Applying an entry twice is a no-op.** Sync redelivers; that must be
   harmless.
9. **Content and meta epochs are never compared.** No cross-namespace
   ordering. (Post validation is *set membership*, not timeline position —
   see below.)

---

## Primitives

**Identifiers**
- **`syncId`** — random, relay-facing circle address. Not derived from any
  key. Stable forever.
- **`circleId`** — local SQLite id. Never sent to the relay. Roots identity
  derivation.

**The two namespaces** — plain sort-key prefixes, `meta#` and `content#`:
- **meta** — *everything content depends on in order to be interpreted*:
  identities, keys, roles, circle metadata. Rare. **Always synced eagerly,
  in full.**
- **content** — posts, comments, reactions, tombstones. Voluminous.
  **Walked forward from a cursor, in pages of 200, only after meta has
  caught up.**

An earlier draft used opaque random tags so the relay couldn't tell which
namespace was which. Dropped: it bought nothing durable — the `rotate`
operation pairs a meta append with a token swap, so the first removal
reveals it regardless, and access patterns (one stream small and always
read in full, one large and paged) leak it before that. Meanwhile it cost
two more values per circle to generate, store, hand to joiners, and carry
in discovery rows, plus unreadable prefixes in logs. Nothing in the
security model rested on it. What *does* stay hidden is the part that
matters: the relay sees "a meta entry" but never `member_added` vs
`key_rotation` vs `profile_update` — types live inside the ciphertext.

"Meta" is defined by *content depends on it*, not by *admins write it* —
which is why a member's own `profile_update` belongs there.

**Keys** (Keychain; all rooted in the master seed)
- **master seed** — the recovery phrase's entropy.
- **circle identity** — Ed25519 (signing) + X25519 (sealing), derived from
  `(seed, circleId)` via different HKDF domains.
- **content-key map `{v → K_v}`** — every version this member holds. `K_v`
  is *shared* by all members of that version.
- **authority key** (admins) — Ed25519, derived from the admin's *own*
  `(seed, "token-authority"‖circleId)`. Private half never leaves them.
- **`writeToken_v = HKDF(K_v, "relay-write-token")`** — shared append
  credential; everyone with `K_v` computes the same one. The relay stores
  only its hash.

**Relay storage**
```
Log table, one partition per syncId:
  sk = "#control"        → { authoritySet, writeTokenHash,
                             metaCounter, contentCounter, deletedAt? }
  sk = "meta#" + <e>     → member_added | member_removed | key_rotation |
                           role_change | profile_update | circle_renamed |
                           cover_photo_set | push_enabled |
                           circle_deleted | account_deleted
  sk = "content#" + <e>  → post | comment | reaction | album_visibility |
                           post_delete
  sk = "idem#<ns>#<entryId>" → retry marker, 48h TTL. The only kind
                           written with an expiry; a deleted circle's meta
                           has one stamped on afterwards (invariant 1).

Blobs (S3, permanent, Glacier-IR after 90 days):
  {syncId}/{entryId}     flat. A post photo's entryId is its
                         client-generated postId; a circle cover's is the
                         literal "cover". Avatars are not blobs — see §9.

Account manifest (`accounts` table; the discovery design in §8 is not
built):
  pk = accountId → one client-encrypted, version-checked blob holding
     { circleId, syncId, keyMap, leftAt? } per membership, plus the
     local profile.
```
Each namespace is its own contiguous sequence with its own counter, both
held in the single `#control` item. Only the two known prefixes are
accepted; an append naming anything else is rejected.

**Entry shape**
- Plaintext (relay sees): `{ epoch, keyVersion, receivedAt,
  authorIdentityPublicKey, deletedAt }`. The author key is declared by the
  writer and verified against nothing — it exists so `deleteentry` and
  `deleteauthorcontent` have something to authorize against. It is still a
  real disclosure: the relay sees a stable per-circle handle on every
  content entry (see the visibility table).
- Inside the ciphertext: `{ type, payload, authorPubkey, signature }` —
  the signature covers `{type, payload}` together, so it can't be
  reinterpreted as a different type over the same payload shape.

---

## Authorization

**Two planes.** The relay never sees entry types, so it cannot key off
them. It keys off **which operation the client invokes**:

| relay operation | relay checks |
|---|---|
| **append** (any entry, either namespace) | write token *(counter bump rides along)* |
| **rotate** (append + token swap, atomic) | write token **+ authority signature** |
| **authority change** (append + set change, atomic) | write token **+ authority signature** |
| **delete circle** (append + stamp + sweep) | write token **+ authority signature** |
| **delete entry** (append + strip one row) | write token **+** the target row's author signature *or* an authority signature |
| **delete author content** (strip every row one identity wrote) | a signature by that identity key itself — the optional tombstone half also needs the write token |
| **delete blob** | write token **+** the uploader's signature *or* an authority signature |

- **Write token** = *"may I append?"*
- **Authority signature** = *"may I change the rules?"* — and the rules are
  exactly two discretionary fields: **`writeTokenHash`** (key change) and
  **`authoritySet`** (set change). Nothing else requires it *alone*: the
  deletions accept it as the admin half of an author-or-admin rule the
  relay can't otherwise apply (the author's key is inside the ciphertext),
  and a cover-photo upload target demands it because that key is
  overwritable and has no first-upload-wins check to fall back on. Counter
  bumps mutate `#control` too, but they're mechanical consequences of an
  authorized append, not discretionary changes, so they ride on the write
  token.
- **An authority change carries an entry, so it needs both.** It appends
  the `role_change` that records it, and every append is possession-gated
  — so the write token rides alongside the signature, exactly as rotate
  does.

**The relay's destructive operations are few, named, and never
automatic.** It appends and it mutates those two control fields. Beyond
that it destroys only when explicitly asked: one blob (`deleteblob`), one
entry's ciphertext and its blob (`deleteentry`), everything one identity
authored and those entries' blobs (`deleteauthorcontent`), or a whole
circle (`deletecircle`). A request destroys the bytes belonging to what it
names and nothing further — a post's photo goes with the post, never on a
timer or a neighbouring request — and there is no "which namespaces
are deletable" flag — only content is ever swept wholesale, and only by a
circle deletion.

Two timers exist, both downstream of an explicit request: idempotency
markers expire after 48h, and a deleted circle's meta after 90 days.

Authority-gating bounds the risk rather than eliminating it: an admin can
destroy shared content server-side, and always could — an authority
signature on `deleteblob` or `deleteentry` covers any entry in the circle,
not only their own. Deleting a circle is the same power exercised at once,
and it costs the entries too.
What no operation can do is remove key material and brick a circle that
still exists: the authority set can never be emptied, and a deleted circle
takes no further writes at all.

**Lying about the operation gains nothing.** Append a rotation-shaped entry
via plain `append` to dodge the authority check → the entry lands but **no
token swap happens**, and clients discard it as not-admin-signed. Inert.
Call `rotate` without an authority signature → rejected.

**Namespace ≠ permission.** The namespace determines *sync behavior*; the
entry type determines *who may write it*. Every finer rule is a
client-side per-type predicate:

| entry | may be written by |
|---|---|
| `post`, `comment`, `reaction` | author ∈ ever-member set |
| `push_enabled`, `account_deleted` | author ∈ ever-member set (both only ever describe their own signer) |
| `post_delete`, `album_visibility` | signer == target post's author, **or** an admin |
| `member_added` | an admin at that point in meta's order |
| `key_rotation` | an admin at that point |
| `role_change` | an admin at that point |
| `member_removed` | an admin at that point, **or** signer == subject (leaving) |
| `circle_renamed`, `cover_photo_set`, `circle_deleted` | an admin |
| `profile_update` | **signer == subject** — structurally, since the entry carries no subject field and can only describe whoever signed it |

Note `member_added` is an admin-only action the **relay does not gate at
all** — it's a plain append, enforced solely by clients at replay. A forged
one is simply discarded.

---

## Operations

### 1. Create a circle
1. Generate `syncId`, `circleId`, `K_1`. Derive circle identity and
   authority key from the founder's seed.
2. → **Relay** (bootstrap — the one call gated by neither capability,
   since nobody can present either for a circle that doesn't exist yet;
   it's protected by the session and by `attribute_not_exists`): register
   `syncId`, `#control = { authoritySet:[founder], writeTokenHash:
   hash(writeToken_1), counters:{meta:0, content:0} }`.
3. → **meta**: `member_added(founder)` with sign + seal public keys, `K_1`
   sealed to the founder's own X25519 key. Signed, encrypted under `K_1`.
4. → record the membership: a discovery row `(discoveryId, circleId →
   {syncId})` once that exists, the account manifest today.
- **Relay learns**: an address, one authority key, a token hash.

### 2. Post
1. **Upload the blob first** to `{syncId}/{postId}` — `postId` is a
   client-generated UUID, deliberately *not* the relay-assigned epoch,
   which isn't known until the append lands and can't be guessed without
   racing other writers. Encrypted under `K_v`. The upload target is
   single-use: a write token proves "a current member," never "the
   original author," so first-upload-wins is what stops one member
   replacing another's photo with a substitute that still decrypts.
2. Then append the entry, encrypted under `K_v`, plaintext `keyVersion`.
   No author name is carried — it resolves live from `circleMembers` at
   render time. A `photoHash` rides inside the *signed* payload, which is
   what lets a reader check the separately-uploaded bytes against what the
   author actually posted; the entry's own signature can't reach them.
- **Ordering matters, and the asymmetry is severe because the log is
  immutable**: blob-then-entry fails into an *unreferenced blob* — nothing
  points at it, it renders nowhere, invisible garbage. Entry-then-blob
  fails into a *dangling reference*: a permanent entry pointing at a photo
  that doesn't exist, which can't be mutated or deleted (invariant 1), so
  the post is broken forever, for everyone, on every device that syncs.
- **[relay checks]** write token → `ADD` the content counter → put entry.
- **Relay learns**: an entry in the content namespace, plus a blob.

### 3. Read / sync
**Meta — eager, always complete:**
1. Query `meta#` since `metaCursor` → apply in order: update
   `circleMembers`, roles, circle metadata; for each `key_rotation`, verify
   the admin signature and open *your own* wrap → add `K_{v+1}`.
2. Loop until `maxReceived == counters.meta`.

**Content — the same forward walk, deferred:**
3. Query `content#` since `contentCursor` → the relay returns up to 200
   entries, ascending. Lazy in *when* it runs, not in direction: there is
   no backward or arbitrary-offset read path, and `getlog` takes only
   `sinceEpoch`.
4. **[client]** decrypt with `K_[keyVersion]` (you hold every key from step
   1); verify signature; check the per-type predicate; render.
- **Why meta must be complete first**: every content entry needs its
  decryption key *and* its author's identity, both of which live in meta.
  That's what makes the content walk safe — you can never land on a post
  whose key or author you're missing.
- **Completeness is epoch-walking against a counter**, not page
  exhaustion: advance the cursor to the last entry actually *processed*,
  never blindly to the counter (guards against a truncated relay
  response). Photo bytes are the part that is genuinely deferred — the log
  pass queues them and a separate queue fetches them, so a slow blob never
  holds up the walk.
- **Post validation is set-membership, not timeline position**: check the
  author against the **ever-member set**. A removed member's past posts
  stay valid — removal doesn't erase history — and it means content and
  meta epochs never need to be comparable.

### 4. Add a member (no key rotation)
1. Requester submits a join request with a one-time keypair.
2. Approver (an admin — the invite's creator) **syncs first**, then seals
   the **underivable minimum** to that key: `{ K-map, syncId, circleName }`.
3. → **meta**: `member_added` with the new member's sign + seal public
   keys, signed by the approver.
4. Joiner derives their identity from *their own* seed, records the
   membership (see §1 step 4), then **walks meta from epoch 0** to build
   the roster, identities, and roles themselves.
- **Handoff carries only what cannot be derived.** The K-map is
  structurally underivable (pre-join rotations contain no wrap for the
  joiner); everything else is derived. This keeps the payload from scaling
  with member count and lets the joiner *verify* history rather than trust
  a summary.
- **No rotation** — adding grants access, revokes no one.

### 5. Remove a member (rotates the key)
1. Admin **syncs meta first**, generates `K_{v+1}`, seals it to each
   remaining member's X25519 key from the **current roster** (the in-order
   fold) — never the ever-member set, which would hand the key to people
   already removed.
2. → append `member_removed { identityPublicKey }` first, awaited, so it
   lands at a lower epoch than its own rotation. Then → **rotate** (one
   atomic transaction): **[relay checks]** write token **and** authority
   signature → append `key_rotation { version, wraps }` (signed, encrypted
   under `K_v`) → swap `writeTokenHash`. Two calls, not one, and both
   direct rather than through the outbox: the rotation kills the write
   token the append needs, so they have to be one sequence rather than two
   entries a drain pushes minutes apart. A failure between them leaves an
   orphaned `member_removed`, which a retry heals.
3. Removed member: no wrap → can't read forward; can't compute the new
   token → can't write. Honest lagging members get a bounced write, treat
   it as "sync, retry."

### 6. Promote an admin
1. The promotee's authority **public** key is already on the log — it rode
   their `member_added`, with a signature by that key over their identity
   key proving they hold it.
2. → **one atomic transaction**: add the key to `#control.authoritySet`
   (**[relay checks]** write token, and signer ∈ set) **and** append
   `role_change`. Never one without the other — divergence between
   `#control` and meta can brick writes (relay accepts a swap whose
   rotation entry every client discards).
- **No key material moves and no roster handoff** — the promotee
  self-derived their authority key and already holds the roster and K-map
  from ordinary eager meta sync. Promotion grants *authority*, not data.

### 7. Demote an admin
1. → **one atomic transaction**: remove the key from `authoritySet`
   (**[relay checks]** write token, and signer ∈ set) **and** append
   `role_change`.
- **Guard: never remove the last authority key.** Enforced inside the
  compare-and-swap as `size(authoritySet) > 1`, because otherwise no one
  could ever rotate, promote, or remove again — and DynamoDB drops a string
  set attribute entirely at zero elements, leaving nothing to add a key
  back to.
- **A signer may remove their own key**, which is how leaving hands
  authority back — just never as the last one out.
- **Demote ≠ remove**: they stay a member, no content-key rotation.
- **Irreducible race**: A-removes-B vs B-removes-A are both validly signed;
  first to land wins. No protocol adjudicates equals.

### 7b. Leaving as the last admin
1. Promote the longest-tenured remaining member (operation 6), **then**
   remove your own key (operation 7), **then** announce the departure.
   Order is forced twice over: the set-size guard rejects the removal if it
   would empty the set, and this device's keys are wiped once the departure
   lands, after which nothing can sign the key out again.
- **Leaving is never blocked.** A circle whose members have no usable
  authority key is left ungovernable rather than the leaver held in it.

### 8. Account recovery (new device)
**Design, not code.** What ships today is the account-keyed manifest:
sign in, `GET /v1/account/manifest` by session, decrypt the blob under
`deriveManifestKey(seed)`, and restore each circle from the `{circleId,
syncId, keyMap}` it carries (`restore-from-phrase.ts`). That works —
`syncId` and the K-map are both in the blob — but only back onto the
*same* provider account. The design below removes that last tie.

1. Sign in with **any** provider account → a session. Which account is
   irrelevant; it's only a bearer credential.
2. Phrase → seed → `discoveryId = HKDF(seed, "account-discovery")` → query
   that partition → one row per membership: `circleId` (the sort key) and
   an encrypted `{syncId}`.
3. Per circle: derive identity from `(seed, circleId)`; decrypt `syncId`.
4. **Walk meta from 0** → roster + full K-map (open your own wraps).
5. Let content catch up in the background as usual.
- **The discovery address would be derived from the seed, not the
  account**, so the phrase alone would suffice. Keyed by `accountId` as it
  is now, losing your Google/Apple account locks you out *even holding the
  phrase*, since `syncId`s are random and can't be re-derived. That is the
  bug this design exists to fix, and it is still open.
- **Why this row is irreducible**: `syncId` is random *and* shared across
  members who each hold different seeds, so no amount of seed material
  reproduces it. (The K-map is underivable for the same structural reason
  — see §4 — which is why today's manifest carries both.) Permanence
  solves *durability*; discovery solves *bootstrapping*. Without it a sole
  founder who loses their device loses the circle permanently, while the
  relay holds every photo intact and unreachable.
- **`accountId` still has user-data associations**, and will until this
  lands: the manifest is keyed on it, holds a `provider` field and the
  local profile, and `recordSignInProviderBestEffort` still writes it.
  Dropping that is part of the same change, not a separate one.

### 9. Change your name or avatar
- One entry type: `profile_update { name, picture? }`, signed, in meta.
  No subject field: the entry describes whoever signed it, so **signer ==
  subject** is structural rather than checked.
- **Avatar rides inside the entry**, as a 96px thumbnail — not a blob at a
  derived key, and not a pointer. Small enough that the entry carries it
  outright, which is why there is no avatar object in S3 at all and no
  invalidation problem to solve. An absent `picture` means *cleared*, not
  *unchanged*.
- **Why the entry is free**: everyone already syncs meta eagerly, so it
  rides along — no polling, no ETag bookkeeping, exact attribution,
  correct ordering.

### 10. Delete content
- **One call, `deleteentry`**: it appends the `post_delete` tombstone and
  strips the target row's ciphertext in the same commit. The row stays —
  comments and reactions reference it by id — stamped `deletedAt`, which
  every client skips quietly rather than logging as a decrypt failure.
  The post's blob goes in the same call, best-effort after the commit: the
  tombstone is the truth clients act on, so a failed blob delete is logged
  rather than retried. `deleteblob` exists for a blob whose entry stays,
  and no client calls it today.
- **Predicate** (client side, on the tombstone): honor only if
  `tombstone.authorPubkey == target.authorPubkey`, or the signer is an
  admin. The relay can't apply that rule — the author's key is inside the
  ciphertext — so it gates the strip on a signature instead: the author's
  own, against the key stamped on the row, or an admin's.
- **Cascade**: a deleted post hides its comments and reactions.
- **A late syncer still pays for the photo.** Content is walked forward,
  so a device behind the post reaches it before its tombstone and queues
  the blob regardless; the fetch then 404s or the row is already stripped.
  Ordering only saves work for devices already caught up.
- **Account deletion is the bulk form**: `deleteauthorcontent` strips
  every content entry one identity wrote, in one pass, authorized by a
  signature from that identity key itself. Deliberately unindexed — a
  paged scan of the circle's content range, since it runs once per
  lifetime.

---

## Extending this design

**The checklist for any new feature:**
1. **Which namespace?** If clients need it *before* they can interpret
   content → meta. Otherwise content.
2. **What's its authorization predicate?** State it as a client-checkable
   rule on the signer.
3. **Does the relay need to enforce anything?** It must be expressible as
   **possession of a capability**. *If it can't be, stop* — that's the
   tripwire.
4. **Idempotent?**
5. **Rebuildable by replay?**
6. **Derived rather than stored?** Prefer `f(seed, stable-id)` over stored
   randomness.
7. **Do old clients discard it safely?** (default-deny)

Adding a type should mean **adding a row to the predicate table** — not
adding a mechanism.

**Tripwires — if you need these, the architecture is wrong for the
feature:**
- **The relay knowing identity** (per-member rate limits, read ACLs,
  "only Alice may X" enforced server-side). Blindness supports possession
  only.
- **Global ordering across namespaces** — anything needing "was X true at
  the instant of this post."
- **Mutable shared server state with multiple writers** — lost updates,
  divergence, and an authorization problem the relay can't solve.
- **Mutating the log** — see invariant 1.
- **Server-side content queries or search** — the relay can't read
  anything.
- **True erasure of data others already hold** — impossible in E2E; the
  honest answer is always "honest clients purge."

---

## How it holds together

**The same plane split is also the visibility boundary.** The constraint
isn't "the relay learns nothing" — it's "nothing *about people or
content*." Structural facts are fine, and some are required:

| | authorization | visibility | mutability |
|---|---|---|---|
| control plane | relay enforces | relay **sees** | mutable |
| data plane | clients enforce | relay **never** sees | append-only |

- **Deliberately visible, load-bearing**: token swaps (revocation *works*
  because the relay sees the credential change), `authoritySet`,
  `writeTokenHash`, `syncId`, registered tags, counters, `keyVersion`.
- **Side-effect visible, accepted**: per-namespace counts and timing,
  approximate member count, blob sizes, and which namespace an entry is in
  (meta vs content — see the note under Primitives).
- **Visible and not yet reckoned with**: the per-circle
  `authorIdentityPublicKey` stamped in plaintext on every content entry
  and on every blob upload, so the relay can authorize a deletion against
  it. It doesn't cross circles — identities are per-circle, so it
  correlates nothing outside one log — but inside a circle the relay can
  group entries by author and count what each one wrote.
- **Never visible**: content, entry types, who was removed, key material.

**Two projections from meta — never conflate:**

| | built by | behavior | used for |
|---|---|---|---|
| **current roster** | in-order fold | **shrinks** on removal | sealing rotations, member list, roles |
| **ever-member set** | union of adds | **never shrinks** | validating post authorship |

Both live in `circleMembers`, maintained **incrementally** (a full fold
only on first sync or recovery). **Removal marks the row rather than
deleting it**, so one table serves the current roster, the ever-member set,
*and* the retained name/avatar that attributes departed members' old posts.

**One identifier, three jobs.** A member's circle pubkey is what signatures
verify against, the `circleMembers` row key, and the cache slot. It's on
every post — so everything about an author resolves from the post itself.

**Avatar resolution — one rule.** `circleMembers[authorPubkey].picture`,
already local by the time any post renders, because the thumbnail arrived
inside a meta entry. Placeholder if never set. No fetch, no staleness, no
second key space.

**Member profiles go in the log. Circle-wide images are blobs.**

| | text (log entry) | image |
|---|---|---|
| member | `profile_update{name}` | thumbnail in the same entry |
| circle | `circle_renamed` | `cover_photo_set` + blob at `{syncId}/cover` |

Only the cover is big enough to be worth a blob, and it's admin-gated, so
its entry carries a `photoHash` and the bytes come down out of band.

**Both resolve live**, and consistently: a post carries only
`authorPubkey`, so name and picture both come from `circleMembers` —
change either and every post of yours updates. An earlier draft
denormalized `authorName` onto each post, which was needed back when a
post might reach a member whose `member_added` hadn't loaded. Eager meta
sync removed that need, and dropping it also removed an odd asymmetry
(names frozen, avatars live).

**One profile, many keys.** A person has a single local profile but a
distinct pubkey per circle, so their picture is published once per circle,
in that circle's own `profile_update` under that circle's `K_v`. The
duplication is required: one shared avatar location, or one byte-identical
ciphertext, would let the relay link memberships.

**Current snapshot without replaying.** For an existing member this already
holds — `circleMembers` and `circles` are maintained incrementally, so
opening a circle is instant. Cold starts are joining (walks meta once,
cheap) and recovery (walks meta once, deliberate). Deliberately *not* a
relay-side mutable snapshot: that reintroduces write-authorization and
divergence problems for little gain.

**Discovery: partition per person, row per membership.** Not built — the
shape below is what replaces today's one-blob-per-account manifest.

```
pk = discoveryId          ← HKDF(seed, "account-discovery")
  sk = circleId-A → enc{ syncId-A }
  sk = circleId-B → enc{ syncId-B }
```

- **Join** inserts one row; **leave** deletes one. No read-modify-write, so
  two of your devices changing membership at once can't clobber each other
  — the same lost-update reasoning that killed the roster blob.
- **"Get all my circles" is one `Query` on `pk`** (no sort-key condition),
  which is the cheapest access pattern DynamoDB has. Rows cost nothing
  extra over a single blob: reads bill per 4KB, not per item, so a dozen
  tiny rows land in the same read unit — and writes get *cheaper*, since a
  row needs no preceding read.
- **What's plaintext is chosen deliberately.** A sort key must be readable
  to be queryable, so something is exposed — and `circleId` is the right
  thing, because it's a random local value used in no other relay-visible
  request. The relay can't join it against anything, and knowing it doesn't
  weaken `deriveCircleIdentity(seed, circleId)` since the seed is the
  secret. `syncId` is the meaningful value, so it's the encrypted one.
  Putting `syncId` in the sort key would link your partition straight to
  specific circles.
- **`accountId` would then have zero user-data associations** — purely a
  bearer credential, no `provider` field, no account-keyed storage. That
  also drops `recordSignInProviderBestEffort`: with a seed-derived
  address, any provider account works, so the hint gates nothing. Today it
  still does all three.

**Privacy posture.** Per-circle identities **silo** metadata — each leak is
scoped to one unlinkable circle. The remaining cross-circle signal is
whatever holds your memberships together: the manifest now, discovery
later.

Be precise about what its encryption buys: values are encrypted under
`deriveManifestKey`, so a **static dump or subpoena** does not reveal the
membership graph — it yields opaque ids and ciphertext. It does **not**
hide membership from an *actively logging* relay: an authenticated device
requesting entries for a `syncId` reveals the association in real time
regardless. Keep it (a passive dump is a real and distinct threat), but
don't over-claim it. Under discovery the relay would learn **how many
circles you're in** from the row count; today's single blob leaks only its
size. The same encryption is why it could never select those rows by
circle, which is what would leave orphaned rows as unreachable dust.

**Recovery floor.** Any top-of-hierarchy compromise can *freeze* writes but
cannot *destroy* — every device holds the full archive and all keys
locally. Worst case: re-found, re-invite, re-upload. The relay was never
the source of truth.

---

## Rationale (condensed)

**Nothing expires.** A 14-day log makes a family-archive product's central
promise false. S3 + Glacier IR makes "keep everything" single-digit
dollars/month at thousands of circles. Removing eviction deleted a lot of
machinery: gap detection, content-gap banners, a durable manifest, the
picture/post prefix split.

**Per-member key wrapping, not one shared secret.** A shared secret had no
clean removal story. Versioned keys sealed per-member, rotated only on
removal: removal is one entry, omission is revocation, history untouched.
This is why `syncId` is decoupled from key material — rotation must never
change the circle's address.

**No roster table.** An earlier draft had one; it was a cache of what meta
replay already gives you, and it brought write-authorization and divergence
problems. The meta namespace *is* the source; `circleMembers` is a local
projection.

**Two namespaces + per-namespace counters.** The eager/lazy split needs
cheap meta-only queries, which needs the relay to separate the ranges —
worth it because a Query bills for what it *reads*, so filtering meta out
of a mixed stream would cost as much as reading every post. Per-namespace
counters keep each range a clean contiguous epoch-walk against its own
counter. The prefixes are plaintext (`meta#`/`content#`) — see Primitives
for why opaque tags weren't worth their cost.

**Per-admin authority keys.** Each admin derives their own from their own
seed; the relay holds the set of public halves. Promotion adds a key,
demotion removes one — no key material moves, each admin recovers their own
from their own phrase.

Since only its owner can derive a key, the owner *publishes* the public
half on their `member_added` — the joiner supplies it in their sealed join
request, the founder puts their own on the entry they self-author. It
travels with a signature by that key over the member's identity public
key: `member_added` is signed by the approving admin, not by the person it
describes, so without that proof anyone could publish someone else's key
as their own and have a promotion install the wrong governor.

Because every member arrives with a key and every change to the set is
atomic with its `role_change`, a client's `role == admin` and membership
of `authoritySet` are the same fact. Clients therefore reason about roles
alone and never track registration separately.

**Discovery would replace the account manifest.** The `accounts` table
holds one document per account. Half the original complaint is already
fixed: the blob now carries `syncId` and the K-map, so recovery does
complete, and a version attribute turned the read-modify-write into a
compare-and-swap instead of a lost-update race. What remains is the part
that matters most — it's keyed on `accountId`, so losing the provider
account still loses the circles. Rows under a seed-derived partition key
are what would fix that, and drop the last account-keyed storage in the
system.

**Table changes**: rename `accounts` → `discovery`; `pk` becomes
`discoveryId`; **add a sort key** (`circleId`) — it's hash-key-only today,
so this is a schema change, not just a new derivation. Client-side
encryption stays exactly as it is (there is no KMS SSE to preserve;
both tables use S3/DynamoDB default encryption).

**DynamoDB.** Almost every access pattern is a point read or bounded range
query — which is why the namespace split matters, since a Query bills for
what it *reads*. Two exceptions, both from deletion: a KEYS_ONLY GSI on
`entryId`, because `deleteentry` has to find a post without knowing its
epoch, and `deleteauthorcontent`'s deliberately unindexed paged scan of a
circle's content range. Photos live on S3; the log is tiny metadata, cheap
to keep forever.

---

## Open issues

1. ~~**Content-side sync bookkeeping.**~~ Moot: content is a single
   forward cursor like meta, so there is no disjoint range to reconcile.
   It came back as a different problem — a device behind a deletion still
   queues the photo (see §10).
2. ~~**`logstore.Read` doesn't paginate.**~~ Fixed: `Read` loops on
   `LastEvaluatedKey` up to its 200-entry page, and `pull-log.ts` advances
   the cursor to the last entry processed, never to `currentEpoch`.
3. **Concurrent rotations need a convergence rule.** Two admins removing
   different members near-simultaneously produce two entries claiming the
   next version. Likely: derive version from epoch order, later one void
   and redone — not settled.
4. **Phrase lost, account intact** → you can find nothing decryptable;
   that's inherent to E2E. Not total loss, though: a member can re-invite
   you and the handoff returns the full K-map, so history comes back — you
   lose only identity continuity (old posts stay attributed to your old
   pubkey). Worth surfacing in the UI as the real fallback. The phrase
   itself is surfaced — `recovery.tsx` saves it as a recovery card the
   person keeps — so this is a UI gap, not a protocol one.
5. ~~**Voluntary leaving isn't designed.**~~ Built: `leaveCircle` queues a
   self-signed `member_removed` through the outbox, handing authority back
   first if the leaver is the last admin. Deliberately no rotation — see
   `leave-circle.ts` for why a departing member must not be able to churn
   everyone's keys.
6. **Missing key version**: `pull-log` logs it, skips the entry, and walks
   past. Defensible (replay from 0 recovers it if the key ever arrives),
   but nothing ever asks for the key, so in practice the entry is lost
   silently to the reader.
7. **Quota and rate limiting are partial.** Per-account budgets exist, and
   S3 caps blob size in the signed policy. What's missing is anything
   per-circle or per-member, and any bound on total retained bytes — and
   the relay has no identity to hang the latter on.
8. **`#control` is the single write bottleneck** — every append is a
   conditional transaction on one item. Fine at family scale; concurrent
   posts cause transaction conflicts and retries.
9. ~~**Nullable `posts.photo`.**~~ Resolved by moving bytes out of `posts`
   entirely: `attachments` is its own table, keyed by `(circleId,
   entryId)`, because a blob has a lifecycle its post doesn't.
10. **Leave/rejoin = fresh identity.** `requestToJoin` mints the
    `circleId` and `completeJoin` adopts it, so a rejoin is a new identity
    to everyone else. Fine by default; documented as deliberate vs. reusing
    the old id to make rejoining continuous.
11. **Circle deletion is a product question**, not just a mechanism: should
    one admin be able to tear down shared history? "Dormant forever" may be
    the more honest default. The relay would accept `deletecircle` from any
    authority signer; the app only offers it to the last member leaving
    (`leave-circle.ts`), so the question is settled in the product and
    still open in the protocol.
12. **Metadata leaks, accepted and named** — see the visibility table.
13. **Device-only state exists** (invariant 6): push mask and silence flag,
    `lastViewedAt` unread marks, and locally-issued invite codes. Each is a
    preference a restored device can default, not shared history — but a
    restore silently resets them, and revoking an invite from a lost device
    is impossible.
