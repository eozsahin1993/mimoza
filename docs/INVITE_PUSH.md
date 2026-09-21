# Invite push

Status: **built**, relay and app. The iOS extension shows a fixed line
per kind; showing the requester's name there too needs the invite code in
the shared Keychain, not done. Pushes for the join handshake in
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
   "There's news on your  ◄───── ◄──────────── push (invite token, no payload)
    request to join"             (title: Family)
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
approve   after putJoinApproval: notifyRequester (empty payload), best-effort
launch    sweepInvitePush: revoked or expired → delete routing, clear column;
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
on joining   same routing id; opening the new circle's feed registers it
             as a circle (content-key lock, no expiry)
```

## Pushes, as delivered

The relay attaches `pushRoutingId`, `kind` and the kind's fixed alert.

```
to the creator                   kind invite
  payload     enc(joinRequestKey, { requesterId, selfReportedName })
  Android     "Priya wants to join" under the circle's name; name capped at 40
  iOS         "Someone wants to join a circle" (the kind's line, in the app's language)
  tap         that circle's feed, request card on top

to the requester                 kind pending_request
  payload     none
  text        "There's news on your request to join" under the circle's name,
              from the local pending row
  tap         the pending screen, which verifies and completes the join
```

The requester's push claims nothing: anyone with the code can read the
request and learn its routing id, so a "You're in" would be forgeable.
Opening the app does the real check.

## Channel and switch

```
Android channel   one shared "invites" channel ("Join requests"), outside the
                  Circles group, created on launch; renamed with the app's
                  language. Muting it stops display.
Account switch    Account → Notifications → Invites, per phone. One switch
                  sets or clears both bits of invitePushMask; the bits stay
                  separate underneath. A cleared bit deletes this phone's
                  device row under that kind's routings; set puts it back.
                  Stops delivery. The prefs row stays: it holds ownership.
```

## Failure

| case | outcome |
|---|---|
| no permission, or the Invites switch off | prefs claimed, no device row; polling finds everything |
| registering push fails | the invite or request goes ahead without push |
| a push fails to send | best-effort, never retried; polling covers it |
| denied or withdrawn | no push; the pending routing expires on its own |
| payload won't open | "Someone wants to join" |
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
