# Invite push

Status: **built**, relay and app. Pushes for the join handshake in
[INVITE_FLOW.md](INVITE_FLOW.md), on the routing kinds in
[PUSH_DESIGN.md](PUSH_DESIGN.md) ("Kinds of routing"). Polling stays; push
only shortens the wait.

## Flow

```
   requester                     relay                    creator
   ─────────                     ─────                    ───────
   register pending routing ──► push rows
   send request ──────────────► mailbox row
   push (invite token) ───────► ─────────────────────────► "Priya wants to join"   (title: Family)
                                 mailbox row ◄──────────── approval
   "Emre accepted your    ◄───── ◄──────────── push (invite token, sealed approval)
    request"                     (title: Family)
   opens app → pending screen completes the join
   joins; the feed re-registers the routing as a circle
```

## Keys

The requester has no content key yet, so both routings are opened by the
one secret both sides hold, the invite code:

```
inviteFanoutToken = HKDF(inviteCode, "invite-push-fanout")
inviteRoutingId   = HKDF(seed, "push-invite" ‖ inviteCode)      creator's; seed, never the code
pendingRoutingId  = HKDF(seed, "push-enabled" ‖ circleId)       requester's future circle routing
```

## Data

```
invite preview (encrypted)    + pushRoutingId          the creator's invite routing
join request                  unchanged                already carries the requester's pushRoutingId
circle_invites                + push_routing_id        null once the relay has deleted it
pending_join_requests         + push_routing_id        the relay expires it; nothing deletes it
invite push categories        joinRequest 0, joinApproved 1   their own set; meaningless without the routing kind
app settings (per phone)      + invitePushMask                 both bits by default
Keychain (shared group)       + invite_join_request_key_<routingId>   deriveJoinRequestKey(code), for the iOS
                                                                 extension; the key reads requests, the code
                                                                 could also send them. Deleted with the routing
iOS push snapshot             + invites                        { pushRoutingId, circleId }, live only
                              + pendingRequests                { requestId, pushRoutingId, circleId, circleName,
                                                                 createdByName, createdByPublicKey }; rewritten
                                                                 after each invite and request
```

## Creator (`createInvite`, `replaceInvite`, `approveJoinRequest`)

```
create    1. code = generateInviteCode()
          2. registerPushForInvite: PUT prefs (kind invite, [joinRequest]),
             PUT device if permitted and the joinRequest bit is set
          3. insertInvite with push_routing_id
          4. createInvitePreview(… pushRoutingId …)       shares a claimed routing
          (2 fails: the invite is still created, with no routing in the preview)
replace   revoke, then unregisterPushForInvite at once; a failure is left to the sweep
approve   after putJoinApproval: notifyRequester with the same sealed bytes
          (empty if over 2500 bytes), best-effort
launch    sweepInvitePush (also when notifications are turned on):
          revoked or expired → delete routing, clear column;
          live → re-send this device (tokens rotate), if the joinRequest bit is set
```

## Requester (`requestToJoin`)

```
1. circleId  = generateUUID()                    local, never shared
2. registerPushForPendingRequest: PUT prefs (kind pending_request, [joinApproved]),
   PUT device if permitted and the joinApproved bit is set
3. putJoinRequest(… pushRoutingId …)             now shares a claimed routing
4. notifyInviteCreator, best-effort
5. insertPendingJoinRequest with push_routing_id
```

```
2 before 3   the request exposes the routing id to every code holder;
             unclaimed, any of them could claim it first
2 fails      the request still goes out, its row's push_routing_id null;
             polling finds the answer. Push is best-effort throughout
no device   the usual first request, made before permission: sweepInvitePush
             adds this device on launch or turning notifications on, if the
             joinApproved bit is set
on joining   same routing id; opening the new circle's feed registers it
             as a circle (content-key lock, no expiry)
```

## Pushes, as delivered

The relay attaches `pushRoutingId`, `kind` and the kind's fixed alert.

```
to the creator                   kind invite
  payload     enc(joinRequestKey, { requesterId, selfReportedName })
  text        "Priya wants to join" under the circle's name; name capped at 40
              payload won't open: "Someone wants to join"
              Android and iOS alike; iOS reads the key from the Keychain
  tap         that circle's feed, request card on top

to the requester                 kind pending_request
  payload     sealToPublicKey({ approval, signature }, requester's ephemeral key):
              the bytes putJoinApproval wrote
  verified    opens with the request's keypair (Keychain, pending_join_keypair_<id>)
              and the signature holds for createdByPublicKey
  text        verified: "Emre accepted your request" under the circle's name
              otherwise: "There's news on your request to join"
              Android and iOS alike; iOS reads the request from the snapshot
  tap         the pending screen, which completes the join
```

Anyone with the code can read the request, learn its routing id and push
it, so the text says "accepted" only when the creator's signature holds,
the same check `checkPendingJoinRequest` makes. The push doesn't complete
the join; opening the app does.

## Channel and setting

```
Android channel   one shared "invites" channel ("Invites"), outside the
                  Circles group, created on launch; renamed with the app's
                  language. Muting it stops display.
Account setting   Account → Notifications → Invites, per phone: join requests
                  and answers (default), join requests only, answers only, or
                  off. Each is a value of invitePushMask. A cleared bit deletes
                  this phone's device row under that kind's routings; set puts
                  it back. Stops delivery. The prefs row stays: it holds
                  ownership.
```

## Failure

| case | outcome |
|---|---|
| no permission, or that kind off in Invites | prefs claimed, no device row; polling finds everything |
| registering push fails | the invite or request goes ahead without push |
| a push fails to send | best-effort, never retried; polling covers it |
| denied or withdrawn | no push; the pending routing expires on its own |
| request payload won't open | "Someone wants to join" |
| approval won't open or verify, or is too big to send | "There's news on your request to join" |
| routing this phone doesn't know | nothing shown on Android; iOS shows the kind's line |

## Leaks

```
anyone with the code   can push the creator, and the requester until they join
                       (per-recipient rate limit; the name was self-reported anyway)
timing                 each send follows a mailbox write on the same tag
                       within a second; not recorded, but visible to the relay
kind                   the relay can tell invite and pending routings apart
```

## Open

- Delete a replaced invite's preview, so the old link stops taking
  requests?
- `member_added` pushes its whole entry, thumbnail included; may exceed
  APNs/FCM's 4 KB. Not measured.
