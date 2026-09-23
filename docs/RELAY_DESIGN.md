# Relay design

Status: **being built.** The circles half is built and answers under
`/v1`, replacing the routes `SYNC_DESIGN.md` and `INVITE_FLOW.md`
describe. Accounts, push and blobs are still as `PUSH_DESIGN.md` and
`ACCOUNT_RECOVERY.md` describe them; this document replaces those two as
they land.

The relay owns accounts, circles, membership, roles, devices and invites
in plaintext. Content is end-to-end encrypted: photos, captions, comments,
reactions and cover photos are sealed under a per-circle key the relay
never holds.

```
device
 ├─ account keypair (X25519, private half in the device keychain)
 └─ per-circle content keys, one per version
        │
        ▼  HTTPS, session bearer token
relay (Lambda)
 ├─ accounts table     account#<id>: profile, devices, providers
 │                     provider#<p>:<sub>: sign-in lookup
 ├─ circles table      circle#<id>: meta, members, sealed keys,
 │                     invites, requests, posts, activity, children
 ├─ sessions, rate-limit tables
 ├─ S3 (via CloudFront) encrypted photo and cover bytes
 └─ APNs / FCM         push, text composed from names + action
```

## What is encrypted

| | who can read it |
|---|---|
| account name, circle name | relay and members |
| membership, roles, who invited whom, activity events | relay and members |
| entry kind, author, timestamps, counts | relay and members |
| post caption, photo, comment text, reaction payload, cover photo, member picture | members only |
| content keys | members only; the relay stores copies sealed to each member |

## Keys

```
account keypair   X25519, random, one per account
content key K_v   random, one per circle per version v; v+1 on every kick
sealed copy       sealTo(accountPubkey, K_v), one per member per version
reaction tag      HMAC-SHA256(HKDF(K_v, "reaction-tag"), emoji), hex
```

- A joiner is sealed every version so far; a kick seals v+1 to each remaining member. Nobody else ever moves keys.
- Content is encrypted under the current version; its `keyVersion` travels in plaintext beside it.
- The relay counts reactions by tag without learning the emoji. Members hold every version and map tags back for the eight palette emoji.

## Accounts table

| pk | sk | attributes |
|---|---|---|
| `account#<id>` | `profile` | name, pubkey, pubkeyUpdatedAt, createdAt |
| `account#<id>` | `device#<deviceId>` | pushToken, platform, locale, updatedAt |
| `account#<id>` | `provider#<provider>:<sub>` | linkedAt, refreshToken (Apple only, for revoking on deletion) |
| `provider#<provider>:<sub>` | `lookup` | accountId |

Account ids are minted by the relay at first sign-in; sign-in resolves
through the `lookup` row.

## Circles table

| pk | sk | attributes |
|---|---|---|
| `circle#<id>` | `meta` | name, coverId, keyVersion, rosterVersion, memberCount, lastEntryAt, createdBy, createdAt |
| `circle#<id>` | `member#<accountId>` | accountId, role `admin\|member`, notifyLevel, needsRewrap, avatarId, avatarKeyVersion, joinedAt |
| `circle#<id>` | `key#<accountId>` | keys `{ "<v>": sealedKey }`, updatedAt |
| `circle#<id>` | `invite#<code>` | createdBy, createdAt, expiresAt |
| `circle#<id>` | `request#<requestId>` | accountId, publicKey, status `pending\|approved\|denied`, createdAt, expiresAt. Indexed by account like a membership, since the asker has no membership to read: the query that answers "which circles am I in" filters on the `member#` prefix, so an ask can never be mistaken for one |
| `circle#<id>` | `entry#<postId>` | type `post`, authorId, keyVersion, ciphertext, hasBlob, visibility, commentCount, reactionCounts `{ tag: n }`, reactors `{ accountId: true }`, commenters `{ accountId: true }`, recentComments, receivedAt, updatedAt, deletedAt, typeReceivedKey, typeUpdatedKey |
| `circle#<id>` | `entry#<activityId>` | type `activity`, event, authorId (who did it), subjectId, subjectName, receivedAt, typeReceivedKey |
| `circle#<id>` | `child#<postId>#comment#<commentId>` | authorId, parentCommentId, keyVersion, ciphertext, receivedAt, deletedAt |
| `circle#<id>` | `child#<postId>#reaction#<accountId>#<tag>` | tag, keyVersion, ciphertext, receivedAt. One row per emoji: a member may hold several at once, and reacting twice with the same emoji is the same row |
| `invite#<code>` | `meta` | circleId, createdBy, createdAt, expiresAt |

- The circles column holds no names. A roster and a list of pending
  requests are joined to the accounts column as they are read, so a
  renamed account is renamed everywhere at once. `subjectName` on an
  activity row is the one copy, taken as the row is written: the wall
  still has to name someone who has since left or deleted their account.
- The key an approver seals a circle to is read from the joiner's
  profile, not sent with the ask, so there is one place for it to live.
  An account that has published none cannot ask to join.
- `recentComments` is the newest N comments, `{commentId, authorId, keyVersion, ciphertext, receivedAt}`, N a relay constant.
- `reactors` and `commenters` are what a card says about **you**: whether you have reacted at all, and whether you have commented. Both are flags rather than detail, because the wall shows a filled state and not which emoji — that comes from the children fetch when a post is opened. A read projects only the caller's own entry, so a page of 200 posts carries 200 booleans rather than every reactor in the circle, and neither answer costs a second read. The flag comes off only with a member's last reaction.
- `reactionCounts` is kept rather than derived from `reactors`, because it is bounded by the emoji palette while `reactors` grows with the roster: inlining the latter would trade a constant for something that scales with the member cap and eats the 1 MB page limit. `ADD` never removes a key, so a tag taken back sits at zero in the item forever; reads drop those on the way out.
- `memberCount` exists so the member cap is a condition on the write rather than a count read beforehand, which two admins approving at once would both pass.
- `needsRewrap` means the member replaced their keypair and their `key#` item is unreadable until another member re-seals it.
- Activity events: `created`, `joined`, `left`, `removed`, `account_deleted`, `promoted`, `demoted`, `renamed`, `cover_changed`. The relay writes each one in the same transaction as the change it records.
- Invites and requests carry `expiresAt`; nothing else expires.

| index | hash | range | used for |
|---|---|---|---|
| `by-type-received` | `pk` | `typeReceivedKey = <type>#<receivedAt:013d>#<id>` | posts backward in creation order; activity |
| `by-type-updated` | `pk` | `typeUpdatedKey = post#<updatedAt:013d>#<postId>` | posts forward, including changed ones |
| `by-account` | `accountId` | `sk` | every circle an account is in |

Blobs live in S3 at `<circleId>/<postId>`, `<circleId>/cover/<coverId>`
and `<circleId>/avatar/<accountId>/<avatarId>`, delivered as CloudFront
URLs signed for an hour. The bytes never pass through the relay in either direction:
an upload is a presigned form the device posts straight to the bucket,
and a download is a signed URL it fetches from the edge.

Every key is written once. A cover id and an avatar id are content
hashes the client computes, so changing either is a new key rather than
an overwrite: a cached copy can never be stale, the edge holds objects
indefinitely, and re-uploading something unchanged is refused because
those exact bytes are already there. Ids that become keys are checked
for shape before they get near one (`internal/util/ids`).

A member's picture is circle content like everything else: sealed under
the circle's content key, stored under that circle's prefix, and recorded
on the membership row as an id and the key version that opens it. The
same face is therefore stored once per circle rather than once per
account, put there by its owner after they are admitted and deleted when
they leave. A pending join request carries a name and no picture: the
asker holds no key yet, so there is nothing they could have sealed one
to.

A blob is uploaded before the entry that references it, so a crash in
between leaves an orphaned object rather than a post pointing at bytes
that never arrived. The relay refuses a second upload target for a key
that already holds bytes: membership proves someone is in the circle,
never that they are a post's author, so without that check any member
could replace a photo with one that still decrypts. A cover takes the
same path with an admin check, matching the change that follows it.

Deletion is the exception, and needs all three of: delete the object,
invalidate that path, and refuse to sign a URL for an entry whose row
carries `deletedAt`. Invalidation is best-effort — the bytes are already
gone — so the signing check is what actually stops a deleted photo being
fetched, and the signed-URL TTL bounds how long an already-issued link
outlives it.

## Writes

| operation | relay does |
|---|---|
| create circle | one transaction: `meta`, founder `member#` (admin), founder `key#` with v1, `activity{created}` |
| post | conditional put of `entry#<postId>`; duplicate id returns the existing entry |
| comment | one transaction: conditional put of the child, `ADD commentCount 1`, and set `recentComments` (see below) |
| react / unreact | read this member's rows on the post; one transaction: put or delete the one for that tag, `ADD` +1/−1 on it, and set or clear the `reactors` flag — clearing only when it was their last |
| delete post | strip ciphertext, set `deletedAt` and `updatedAt`, delete the blob |
| approve join | one transaction: `member#`, the joiner's `key#` with every version, `rosterVersion + 1`, request approved, `activity{joined}` |
| kick | one transaction: delete `member#` and the leaver's `key#`, add v+1 to each remaining `key#`, `meta{keyVersion + 1, rosterVersion + 1, memberCount − 1}` conditioned on the version read, `activity{removed}` |
| leave | same shape as kick, self-directed: delete own `member#` and `key#`, add v+1 to each remaining `key#`, `meta{keyVersion + 1, rosterVersion + 1, memberCount − 1}` conditioned on the version read and, for an admin, on another admin remaining, `activity{left}` |
| role change, rename, cover | row update with an admin check, `rosterVersion + 1` where membership changes, matching activity. A request that sets both a name and a cover records both |
| notification level | the member's own row, no activity — nobody else needs to know — but `rosterVersion + 1`, so that account's other devices refetch |
| visibility, delete post, delete comment | see Reads: each stamps `updatedAt` and the forward index key, so the change reaches every device through the walk |
| delete circle | every row in the partition, in batches, plus the lookup row each invite code owns |

Every write moves `meta.lastEntryAt`, activity included, so a device can skip a circle where nothing has happened.

**`recentComments` at N = 1** is a plain `SET` of the new comment, so
concurrent comments resolve to whichever transaction commits last, which
is the newest. Raising N means prepending with `list_append` and removing
the tail index in a second update, which is not a read-modify-write and
so cannot lose a comment, but can transiently hold N+1 entries, or drop a
middle one while two prepends interleave. It converges on the next
comment, and the post screen's own fetch is authoritative either way. A
preview that must be exact at N > 1 would have to be rebuilt from a query
instead.

Counts only ever change by `ADD` deltas, so concurrent reactions and
comments compose in any order. The kick is the only write conditioned on
a shared value; the loser of a race gets 409 and retries.

A kick's transaction holds 3 + N items against DynamoDB's limit of 100,
so circles cap at 50 members, enforced at approval.

Every write to a post returns the post's full entry, so the device can
replace its local copy at once.

## Reads

```
GET /circles
  → per circle: name, role, keyVersion, rosterVersion, lastEntryAt,
    notifyLevel, needsRewrap; and this account's own join requests with
    the circle each names. An answered ask stays here until it expires,
    so the device that made it sees the answer rather than watching the
    ask disappear

GET /account
  → the caller's own profile. No account id in the path: the session is
    what says whose it is, and it is the only one they may read

GET /circles/{id}/roster
  → rosterVersion, members [accountId, name, avatarId, avatarKeyVersion,
    pubkey, role, joinedAt, needsRewrap], the caller's sealed keys

GET /circles/{id}/entries?type=post|activity&cursor=<opaque>&limit=200
  → entries, next, prev, more

GET /circles/{id}/entries/{postId}/children
  → comments, reactions

POST /circles/{id}/blobs/{postId}/upload-target
POST /circles/{id}/blobs/cover/{coverId}/upload-target
POST /circles/{id}/blobs/avatar/{avatarId}/upload-target
  → a presigned form, refused where bytes already sit at that key

GET /circles/{id}/blobs/{postId}
GET /circles/{id}/blobs/cover/{coverId}
GET /circles/{id}/blobs/avatar/{accountId}/{avatarId}
  → a URL signed for an hour, refused for a post that is deleted or
    never had a photo
```

A post entry in a page carries its counts, `recentComments`, and what the
caller themselves did — `iReacted` and `iCommented`, projected from the two
maps above — so the feed renders from posts alone. Comments and reactions
beyond that are fetched when a post is opened.

**Cursor.** `base64url({v, type, t, id, d: fwd|back, cont})`, read only
by the relay. Every page is one Query for the next 200 rows after a
position in an index:

| | index | position |
|---|---|---|
| posts forward | `by-type-updated`, ascending | `t#id` exactly when continuing a page run; `t − 30 s` at the start of a sync |
| posts backward | `by-type-received`, descending | `t#id` |
| activity | `by-type-received`, either direction | as above, and a forward walk rewinds the same 30 s: an activity row cannot change, but it can still land behind a cursor |

A page hands back two cursors, and each takes the entry that is last in
**its own** index — the greatest `updatedAt` for forward, the smallest
`receivedAt` for backward — not the last row of the page, which is only
ordered by whichever index that read happened to use.

The 30-second step back at the start of a sync covers a write that landed
late or an index that lagged; the device ignores entries it already
holds. A post's `updatedAt` only moves forward, so a changed post
re-enters the walk ahead of the cursor rather than behind it.

**That rewind is a window, and a window can always be beaten.** A write
can land behind it — the handler stamps a post before the write commits,
so a slow write commits after a faster one with an earlier stamp, and
index propagation has no documented bound either. Measured on a burst of
20 concurrent posts, a walk that never rewinds missed 9 of them, and the
rewind recovered every one (`spike_test.go`).

What catches the rest is a count, not a wider window:

```
GET /circles/{id}/entries?type=post&count=1  → { count }
```

The device compares it with the posts it holds. Both sides are read
through the same index, so a post that has not propagated yet is missing
from both and raises no false alarm; once it propagates the counts
disagree, and the device pages **backward** through `by-type-received`,
where a key never moves, until the two agree again. `lastEntryAt` is only
a hint that something happened at all, since a late write stamps an
older time than one already seen.

## Push

The relay sends after each write, to the devices of every member whose
`notifyLevel` covers the action, minus the actor, plus the post's author
for a comment or reaction on their post.

```
APNs  aps.alert { title-loc-key, loc-key, loc-args }
FCM   notification { title_loc_key, body_loc_key, body_loc_args }
both  data { circleId, entryId, type, parentEntryId }
```

The device localizes the text from names and the action. Comment text is
encrypted and never on a lock screen, and a reaction's emoji is a keyed
tag the relay cannot read back, so a card says someone reacted and not
what with. Roster changes send a silent push so members' devices sync,
whatever level they have set: a level governs cards, not syncing.

Because the card arrives finished, nothing decrypts on receipt and no
notification extension ships. The cost is that the wording lives in the
app's native string tables, so a new kind of notification needs an app
release rather than a relay deploy.

## New device

- With the keypair in the synced keychain: sign in, list the circles, fetch rosters, open sealed keys.
- Without it: the device makes a new keypair and sends it with `reset`. The relay marks every membership `needsRewrap` and pushes the other members silently. The first member device to sync seals every version it holds to the new pubkey; the relay stores it and clears the flag.

A relay that swapped in its own pubkey could have a member seal keys to
it. Accepted: the relay already controls delivery and deletion. The same
holds for whoever controls the Google or Apple account, since a session
is all that is needed to publish a key. Neither can read what is already
stored; both are granted the circle by the next member who reseals.

**There is no key escrow, and deliberately so.** The private key is never
recovered, only replaced, and what comes back is entitlement rather than
a secret: other members reseal the content keys to the new public key.
Any relay-held backup, whether wrapped with a passphrase or anything
else, would make the product only as strong as that secret, which is the
one thing this design refuses. Losing the key is instead made rare by the
platform keychains, which are end-to-end encrypted against Apple and
Google: iCloud Keychain on iOS, Block Store on Android.

Two cases have no answer and are accepted. Someone whose platform backup
is switched off cannot be warned in advance, because neither platform
reports it, and will wait for a member to reseal. And a circle whose
every member loses their key, which in practice means a circle of one, is
unreadable for good, since nothing anywhere still holds its content key.

## Account deletion

Revoke the Apple grant, then for each circle: strip the account's
entries and blobs, delete its `key#` and `member#`, write
`activity{account_deleted}`, and promote the longest-standing member if
it was the last admin. Then delete its requests, invites, devices,
provider rows, profile and sessions.
