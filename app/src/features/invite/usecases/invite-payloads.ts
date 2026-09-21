/**
 * The JSON shapes carried inside the invite flow's encrypted mailbox rows.
 * Shared between invite-to-circle.ts (creator side) and join-circle.ts
 * (requester side) — kept in their own file rather than either usecase,
 * since both sides need to encode one of these and decode another, and
 * neither side should import the other's module just for a type.
 */

/**
 * What an invite's row (`sk = "invite"`) decrypts to — written once by the
 * creator, read by anyone who taps the invite link, encrypted under
 * `deriveInvitePreviewKey`. Just the name for now — a cover-photo preview
 * is deferred until circle-level "current state" (name/photo as of now,
 * not as of invite-creation) has a real design, rather than bolting a
 * one-off snapshot onto this payload ahead of that.
 */
export type InvitePreviewPayload = {
  name: string;
  /**
   * The creator's own display name at the moment the invite was created —
   * shown as "X has invited you to Y" on the join preview. Self-reported,
   * same trust tier as everything else here (see `JoinRequestPayload`'s
   * `selfReportedName`), not re-derived later if they rename themselves.
   */
  createdByName: string;
  /**
   * The creator's avatar as a base64 JPEG thumbnail, when they have one —
   * so the join sheet can show who is inviting you rather than a blank
   * circle. Same self-reported tier as `createdByName`, validated on the
   * way out by `parsePictureThumbnail` like every other picture that
   * crosses a trust boundary.
   */
  createdByPicture?: string;
  /**
   * Hex-encoded Ed25519 public key — the invite creator's own circle
   * identity (see `deriveCircleIdentity`). Carried here, not fetched from
   * anywhere else, because the requester has no other way to learn it
   * before joining: this is what lets a later approval be verified as
   * having actually come from this specific invite's creator (see
   * `JoinApprovalEnvelope`), not just from anyone who happened to know
   * both the invite code and the circle secret.
   */
  createdByPublicKey: string;
  /**
   * The creator's push routing id for this invite (`derivePushInviteRoutingId`),
   * which the requester sends to once their request is in. Absent on
   * invites created before invite push existed.
   */
  pushRoutingId?: string;
};

/**
 * What a join request row's `encryptedRequest` decrypts to — written by
 * the requester, read by the invite's creator, encrypted under
 * `deriveJoinRequestKey`. The self-reported name (and picture) are
 * explicitly not verified identity — exactly as spoofable as typing any
 * name at profile setup — so the approval screen should be framed around
 * what the approver actually knows ("someone used the invite"), not
 * presented as a confirmed identity.
 */
export type JoinRequestPayload = {
  /** Hex-encoded X25519 public key — the requester's one-time ephemeral keypair for this handshake. */
  ephemeralPublicKey: string;
  /**
   * Hex-encoded Ed25519 public key — the requester's *durable* circle
   * identity (see `deriveCircleIdentity`), not the ephemeral key above.
   * Carried so the approver can name this member in the `member_added`
   * entry it writes: that entry may only be written by an admin, so the
   * joiner cannot announce itself — nobody would have vouched for it.
   * Every other device uses this key to verify that member's future post
   * signatures.
   */
  identityPublicKey: string;
  /**
   * Hex-encoded X25519 public key — the requester's durable sealing key
   * (see `deriveCircleSealingKeypair`). Also goes into `member_added`,
   * because it's what a future `key_rotation` seals the new content key
   * to. Distinct from `ephemeralPublicKey`, which exists only for this one
   * handshake and is discarded after it.
   */
  encPublicKey: string;
  /**
   * Hex push routing id, derived client-side from the requester's own
   * seed for this circle, carried so the approver can put it on
   * `member_added` and this member is reachable from the moment they
   * join. Always sent, whether or not notifications
   * are on yet: it only names where to deliver, and the relay drops a
   * target with no registration behind it.
   */
  pushRoutingId?: string;
  /**
   * Hex-encoded Ed25519 authority public key (see
   * `deriveAuthorityKeypair`), carried for the same reason
   * `identityPublicKey` is — the approver can't derive it, and putting it
   * on `member_added` is what makes this member promotable later without
   * their device having to be online to publish it first.
   */
  authorityPublicKey?: string;
  /**
   * Signature by that authority key over `identityPublicKey` — see
   * `deriveAuthorityKeyProofMessage`. Without it the approver would be
   * vouching, with their own signature, for a key they cannot check.
   */
  authorityKeyProof?: string;
  selfReportedName: string;
  /**
   * Base64-encoded avatar-sized JPEG thumbnail (see
   * `compressToThumbnail`) of the requester's local profile picture, if
   * they have one — optional, since profile setup doesn't require a
   * picture. Small on purpose: this rides inside a request row meant to
   * stay small, not the full-quality picture the roster eventually gets
   * once the join actually completes.
   */
  pictureThumbnail?: string;
};

/**
 * What a join request's `encryptedApproval` decrypts to, once opened via
 * `openSealedBox` — written by the creator, sealed to the requester's
 * `ephemeralPublicKey` (not code-derived like the two payloads above).
 */
export type JoinApprovalPayload = {
  /**
   * The approver's *entire* version→content-key map (each value hex-
   * encoded), not just the current version: a joiner needs every version
   * to decrypt history predating their join, not only new content going
   * forward. Today this only ever has one entry (`{1: ...}`), since key rotation
   * itself isn't built yet — but the shape doesn't need to change when it
   * is; there's simply nothing beyond version 1 to include yet.
   */
  keyMap: Record<number, string>;
  /**
   * The circle's relay-facing address — without this, a joiner has
   * nothing that can actually reach the relay (the pre-redesign version
   * of this payload didn't carry it at all, and could only complete
   * "locally," the same structural gap the old account-manifest had).
   */
  syncId: string;
  circleName: string;
};

/**
 * The actual sealed payload: the approval plus a signature over it, made
 * with the *approver's own* circle-identity secret key. The requester
 * verifies this against the `createdByPublicKey` it captured from the
 * invite's preview (see `InvitePreviewPayload`) before trusting `approval`
 * at all — without this, anyone who knows both the invite code and the
 * circle secret (any existing member, not just this invite's creator)
 * could forge a fully-working approval, since the code alone hands them
 * the requester's ephemeralPublicKey and the secret is the same one every
 * member already has. Signing binds the approval to the one identity that
 * actually matters: the specific device that created this invite.
 */
export type JoinApprovalEnvelope = {
  approval: JoinApprovalPayload;
  /** Hex-encoded Ed25519 signature over `JSON.stringify(approval)`, by `createdByPublicKey`'s matching secret key. */
  signature: string;
};
