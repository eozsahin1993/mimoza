# Sync design

How a device keeps itself in step with the relay. `RELAY_DESIGN.md` is
the other half: what the relay stores and what its routes promise.

The relay owns membership, so a device no longer replays a signed log to
work out who is in a circle — it reads state and writes it down. What it
keeps is a projection shaped for the screens, not a mirror of the
relay's tables.

```
GET /account ─────► device_profile
GET /circles ─────► circles, pending_requests
   │  per circle, when a version moved
   ├─ GET /circles/{id}/roster ──► circle_members + sealed keys → keychain
   ├─ outbox drain ──────────────► POST entries, comments, reactions
   ├─ GET /circles/{id}/entries?type=post     ──► posts
   ├─ GET /circles/{id}/entries?type=activity ──► activity
   └─ photo queue ───────────────► attachments (bytes, later)

on opening a post:
   GET /circles/{id}/entries/{postId}/children ──► post_comments, post_reactions
```

## Two calls, not one

`GET /account` is the profile. `GET /circles` is every circle this
account is in plus every ask it is waiting on. A pass starts with both;
nothing else is fetched for a circle whose `rosterVersion` and
`keyVersion` have not moved.

A circle the relay stops listing is one this account left or was removed
from. Its rows stay, with `leftAt` set — left, not erased, so what was
already synced stays readable offline.

## What each table is for

| table | written by | note |
|---|---|---|
| `circles` | the circle list | relay's half plus this device's cursors and `lastViewedAt` |
| `circle_members` | the roster fetch | departures set `leftAt` rather than deleting, so an old post still resolves to a name |
| `activity` | the activity walk | relay-written history; the wall interleaves it with posts |
| `posts` | the post walk | carries a relay-owned block, below |
| `post_comments` | post previews, the children fetch, own writes | own writes are `pending` until confirmed |
| `post_reactions` | the children fetch, own writes | partial cache; `pendingOp` is a queued tap |
| `attachments` | whatever names a blob | bytes arrive later, through the photo queue |
| `outbox` | own content writes | drains in order |

## One writer per table

The relay-owned half of a post — `updatedAt`, `commentCount`,
`reactionCounts`, `unnamedReactions`, `recentCommentIds`, `iReacted`,
`iCommented` — is replaced wholesale by sync and never touched by a
local action. Optimistic state is derived at read time instead: the
shown reaction count is the relay's counts plus what the outbox still
holds, and a pending comment is a row flagged as such.

That is what keeps the two from needing reconciliation. Every write
answers with the post's fresh state in the shape a walk carries, so the
device that made the change applies it through the same path a sync
uses, and the optimistic adjustment is replaced by the relay's truth the
moment the write lands.

## Cursors

Opaque strings. Only the relay reads them; a device stores what it was
handed and gives it back.

Posts have two, because they move in two directions. Forward walks by
`updatedAt`, so one walk delivers new posts, changed counts, visibility
changes and deletions alike. Backward walks by `receivedAt`, which is
history and never changes. Activity has one, forward.

A circle with no cursor reads the newest page, which comes back walking
*backward* — its `more` is about history, not about catching up. So that
read takes one page and seeds both cursors.

An empty page carries no cursors at all. Saving those would rewind the
stream to "newest page" on the next pass, so they are ignored.

Cursors never rewind. A failure that could succeed later has to leave
the position alone rather than walk past the entry, which is why a
transient error ends a pass where it stands while an entry that can
never be applied is logged and skipped.

## Children are a partial cache

Comments beyond the preview, and reactions, are fetched when a post is
opened — never walked. `posts.childrenFetchedAt` records when, and a
post is refetched only when it is older than `posts.updatedAt`. A post
nobody has touched since the last open costs no request.

Nothing on the wall reads those two tables, so their staleness cannot
show anywhere the relay has not already reported through `updatedAt`.

## The outbox

Content writes queue and drain in order. Roster changes do not: they
need the current roster anyway, so they are direct calls that fail in
front of whoever made them.

Order is load-bearing — a comment must never reach the relay before the
post it is on — so a row that fails holds back everything queued behind
it rather than being skipped.

A failure the relay *returned* spends one of five attempts and backs off;
past that the row is marked failed and surfaces as a banner. A request
that never reached the relay spends nothing and waits a flat thirty
seconds, so no amount of time offline can fail a write.

Content is sealed at drain time, not when the row was queued, so a key
rotation in between is not a problem.

## Push

A device registers its token, platform and locale against itself
(`PUT /account/devices/{deviceId}`) and sets a per-circle `notifyLevel`
on its own membership row. Nothing else is device-side: the relay
composes the card and the device only localizes it, so a tap routes from
`data.circleId` / `data.entryId` and nothing decrypts on receipt.

## Keys

One content key per circle per version, in the device keychain. Old
versions are kept forever: content stays under whichever key was current
when it was written.

The roster hands back this account's own sealed copies, by version, and
nobody else's. They are opened with the account keypair and merged in; a
version that will not open is skipped rather than failing the pass —
it was sealed to a keypair this device replaced, and a member reseals it
once they see `needsRewrap`.

Reaction tags are derived from the circle's *first* content key and never
rotate. See `RELAY_DESIGN.md` for why.

## Ordering that matters

Keys land before entries are walked. A page encrypted under a version
this device has not been given would be skipped, and cursors do not
rewind.

The roster is applied before activity is replayed — and because a first
sync walks the whole history, an old `left` entry must not hide a member
who has since rejoined. Current state wins over replayed history; the
member's current `joinedAt` is what tells the two apart.
