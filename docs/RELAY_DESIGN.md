# Relay design

Status: **being built.** The relay running today is described by
`SYNC_DESIGN.md`, `PUSH_DESIGN.md`, `INVITE_FLOW.md` and
`ACCOUNT_RECOVERY.md`; this document replaces them once built.

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
| account name, avatar, circle name | relay and members |
| membership, roles, who invited whom, activity events | relay and members |
| entry kind, author, timestamps, counts | relay and members |
| post caption, photo, comment text, reaction payload, cover photo | members only |
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
| `account#<id>` | `profile` | name, avatarKey, pubkey, pubkeyUpdatedAt, createdAt |
| `account#<id>` | `device#<deviceId>` | pushToken, platform, locale, updatedAt |
| `account#<id>` | `provider#<provider>:<sub>` | linkedAt, refreshToken (Apple only, for revoking on deletion) |
| `provider#<provider>:<sub>` | `lookup` | accountId |

Account ids are minted by the relay at first sign-in; sign-in resolves
through the `lookup` row.

## Circles table

| pk | sk | attributes |
|---|---|---|
| `circle#<id>` | `meta` | name, coverId, keyVersion, rosterVersion, lastEntryAt, createdBy, createdAt |
| `circle#<id>` | `member#<accountId>` | accountId, role `admin\|member`, notifyLevel, needsRewrap, joinedAt |
| `circle#<id>` | `key#<accountId>` | keys `{ "<v>": sealedKey }`, updatedAt |
| `circle#<id>` | `invite#<code>` | createdBy, createdAt, expiresAt |
| `circle#<id>` | `request#<requestId>` | accountId, pubkey, status `pending\|approved\|denied`, createdAt, expiresAt |
| `circle#<id>` | `entry#<postId>` | type `post`, authorId, keyVersion, ciphertext, hasBlob, visibility, commentCount, reactionCounts `{ tag: n }`, recentComments, receivedAt, updatedAt, deletedAt, gsi1sk, gsi3sk |
| `circle#<id>` | `entry#<activityId>` | type `activity`, event, actorId, subjectId, subjectName, receivedAt, gsi1sk |
| `circle#<id>` | `child#<postId>#comment#<commentId>` | authorId, parentCommentId, keyVersion, ciphertext, receivedAt, deletedAt |
| `circle#<id>` | `child#<postId>#reaction#<accountId>` | tag, keyVersion, ciphertext, receivedAt |
| `invite#<code>` | `meta` | circleId |

- `recentComments` is the newest N comments, `{commentId, authorId, keyVersion, ciphertext, receivedAt}`, N a relay constant.
- `needsRewrap` means the member replaced their keypair and their `key#` item is unreadable until another member re-seals it.
- Activity events: `created`, `joined`, `left`, `removed`, `account_deleted`, `promoted`, `demoted`, `renamed`, `cover_changed`. The relay writes each one in the same transaction as the change it records.
- Invites and requests carry `expiresAt`; nothing else expires.

| index | hash | range | used for |
|---|---|---|---|
| `by-type-received` | `pk` | `gsi1sk = <type>#<receivedAt:013d>#<id>` | posts backward in creation order; activity |
| `by-type-updated` | `pk` | `gsi3sk = post#<updatedAt:013d>#<postId>` | posts forward, including changed ones |
| `by-account` | `accountId` | `sk` | every circle an account is in |

Blobs live in S3 at `<circleId>/<postId>` and `<circleId>/cover/<coverId>`.
Every key is written once, so the CDN caches all of them indefinitely.

## Writes

| operation | relay does |
|---|---|
| create circle | one transaction: `meta`, founder `member#` (admin), founder `key#` with v1, `activity{created}` |
| post | conditional put of `entry#<postId>`; duplicate id returns the existing entry |
| comment | one transaction: conditional put of the child, `ADD commentCount 1`, prepend to `recentComments`; then trim to N |
| react / unreact | read own slot; one transaction: put or delete the slot conditioned on what was read, `ADD` −1/+1 on the old and new tag |
| delete post | strip ciphertext, set `deletedAt` and `updatedAt`, delete the blob |
| approve join | one transaction: `member#`, the joiner's `key#` with every version, `rosterVersion + 1`, request approved, `activity{joined}` |
| kick | one transaction: delete `member#`, add v+1 to each remaining `key#`, `meta{keyVersion + 1, rosterVersion + 1}` conditioned on the version read, `activity{removed}` |
| leave, role change, rename, cover | row update with an admin check, `rosterVersion + 1` where membership changes, matching activity |

Counts only ever change by `ADD` deltas, so concurrent reactions and
comments compose in any order. The kick is the only write conditioned on
a shared value; the loser of a race gets 409 and retries.

A kick's transaction holds 3 + N items against DynamoDB's limit of 100,
so circles cap at 50 members, enforced at approval.

Every write to a post returns the post's full entry, so the device can
replace its local copy at once.

## Reads

```
GET /me
  → profile, and per circle: name, role, keyVersion, rosterVersion,
    lastEntryAt, notifyLevel, needsRewrap; pending join requests

GET /circles/{id}/roster
  → rosterVersion, members [accountId, name, avatarKey, pubkey, role,
    joinedAt, needsRewrap], the caller's sealed keys

GET /circles/{id}/entries?type=post|activity&cursor=<opaque>&limit=200
  → entries, next, prev, more

GET /circles/{id}/entries/{postId}/children
  → comments, reactions
```

A post entry in a page carries its counts, `recentComments` and the
caller's own reaction, so the feed renders from posts alone. Comments and
reactions beyond that are fetched when a post is opened.

**Cursor.** `base64url({v, type, t, id, d: fwd|back, cont})`, read only
by the relay. Every page is one Query for the next 200 rows after a
position in an index:

| | index | position |
|---|---|---|
| posts forward | `by-type-updated`, ascending | `t#id` exactly when continuing a page run; `t − 30 s` at the start of a sync |
| posts backward | `by-type-received`, descending | `t#id` |
| activity | `by-type-received`, either direction | as above |

The 30-second step back at the start of a sync covers a write that
landed late or an index that lagged; the device ignores entries it
already holds. A post's `updatedAt` only moves forward, so a changed post
re-enters the walk ahead of the cursor and is never skipped behind it.

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
encrypted and never on a lock screen. Roster changes send a silent push
so members' devices sync.

## New device

- With the keypair in the synced keychain: sign in, `/me`, fetch rosters, open sealed keys.
- Without it: the device makes a new keypair and sends it with `reset`. The relay marks every membership `needsRewrap` and pushes the other members silently. The first member device to sync seals every version it holds to the new pubkey; the relay stores it and clears the flag.

A relay that swapped in its own pubkey could have a member seal keys to
it. Accepted: the relay already controls delivery and deletion.

## Account deletion

Revoke the Apple grant, then for each circle: strip the account's
entries and blobs, delete its `key#` and `member#`, write
`activity{account_deleted}`, and promote the longest-standing member if
it was the last admin. Then delete its requests, invites, devices,
provider rows, profile and sessions.
