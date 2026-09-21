import { sql } from 'drizzle-orm';
import { blob, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const circles = sqliteTable('circles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Cover photo picked on creation, if any — separate from any post's photo. */
  picture: blob('picture').$type<Uint8Array>(),
  /**
   * `hashBytes(picture)` at the moment it was last written. The cover's
   * cached file path is versioned by it (see photo-cache.ts's coverFile),
   * so a changed cover gets a new path without re-reading the blob. Null
   * for covers stored before this column; circle-cover.ts backfills them.
   */
  pictureHash: text('picture_hash'),
  /**
   * The relay-facing address for this circle's log — random, independent
   * of key material so rotation never repoints it. Stored, never derived.
   */
  syncId: text('sync_id').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  /**
   * Which notification categories this circle sends, as a bitmask — see
   * `PushCategories`. Local is the source of truth: the relay holds routing
   * rows but has no read endpoint, so a screen would otherwise have nothing
   * to render. Defaults to everything on; a circle is reachable from the
   * moment you join without anyone opting in.
   */
  pushCategoryMask: integer('push_category_mask').notNull().default(15),
  /** Silenced outright, independent of the mask, so the categories survive being switched back on. */
  pushSilenced: integer('push_silenced', { mode: 'boolean' }).notNull().default(false),
  /**
   * The content-key version the relay's fanout hash was last written for.
   * The hash follows the current key, so this lagging after a rotation
   * means senders' tokens no longer match it and the circle has gone
   * quiet — see `resyncPushIfStale`. Null until this device first
   * registers, so a circle nobody enabled push for is never written.
   */
  pushKeyVersion: integer('push_key_version'),
  /** Set when this device leaves the circle — kept (not deleted) so already-synced posts stay as a local archive. */
  leftAt: integer('left_at'),
  /**
   * How far this device has synced each namespace. Tracked separately
   * because meta and content sync differently — meta is synced eagerly
   * and in full, content is paged backward lazily — so one cursor can't
   * serve both. 0 means never synced.
   */
  metaCursor: integer('meta_cursor').notNull().default(0),
  contentCursor: integer('content_cursor').notNull().default(0),
  /**
   * When this device last opened this circle's feed — the unread-count
   * badge's floor for "new post". Set to `createdAt` at insert time (this
   * device's own join/creation moment), never left null: a fresh join's
   * entire pulled-in history must never look unread, and `createdAt`
   * already means "when this device first knew about this circle" (see
   * create-circle.ts and join-circle.ts).
   */
  lastViewedAt: integer('last_viewed_at').notNull().default(0),
});

export const circleMembers = sqliteTable(
  'circle_members',
  {
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    /** Ed25519 signing key (hex) — see `deriveCircleIdentity`. Verifies who signed a log entry. */
    identityPublicKey: text('identity_public_key').notNull(),
    /**
     * X25519 sealing key (hex) — see `deriveCircleSealingKeypair`. Needed
     * to seal a rotated content key to this member. Defaults to '' so
     * `ALTER TABLE ADD COLUMN` stays valid against existing rows.
     */
    encPublicKey: text('enc_public_key').notNull().default(''),
    /**
     * This member's push routing id (hex) — derived client-side from
     * their own seed and this circle, not a random per-install value, so
     * it's stable across their devices without ever needing to be
     * re-registered. Empty until they publish one, which is also how a
     * member who has never opted into notifications stays untargetable.
     */
    pushRoutingId: text('push_routing_id').notNull().default(''),
    /**
     * This member's authority (Ed25519) public key, hex — see
     * `deriveAuthorityKeypair`. Only its owner can derive it, so it
     * arrives on their `member_added` with a signature by that key
     * proving they hold it; whoever promotes them needs it, because the
     * relay's authority set is keyed on this and not on the identity key.
     */
    authorityPublicKey: text('authority_public_key').notNull().default(''),
    memberId: text('member_id').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
    name: text('name').notNull(),
    picture: blob('picture').$type<Uint8Array>(),
    joinedAt: integer('joined_at').notNull(),
    /**
     * Set when an admin removes this member — kept, never deleted (see
     * `authoredByMember` in sync/entry-handlers/types.ts): the row is
     * still the "ever-member" proof that a post/comment/reaction authored
     * before removal must keep passing. `getCircleMembers` filters this
     * out; `getMemberByPublicKey` deliberately doesn't.
     */
    removedAt: integer('removed_at').default(sql`null`),
  },
  (t) => [
    primaryKey({ columns: [t.circleId, t.identityPublicKey] }),
    uniqueIndex('circle_members_member_id').on(t.circleId, t.memberId),
  ]
);

/**
 * Every roster change this circle has seen — one row per event, append-
 * only, the local projection of the `member_added`/`member_removed`/
 * `role_change` entries in meta.
 *
 * Separate from `circle_members` because that table is *state* (who is
 * here now, what can they do) while this is *history* (what happened, in
 * order, and who did it). A single roster row can only hold one
 * `joinedAt`/`removedAt` pair, so it cannot represent someone leaving and
 * later rejoining — and attribution is a property of each event, not of
 * the person: two removals across two stints can have two different
 * admins behind them.
 *
 * Scope is deliberately "things that happen to a member", i.e. exactly
 * the events whose current-state projection is `circle_members`. A future
 * `circle_renamed` or `cover_photo_set` projects onto `circles` instead
 * and belongs elsewhere, or this table grows two unrelated write paths.
 *
 * Names are never stored here — `subjectPublicKey`/`actorPublicKey`
 * resolve against `circle_members` at read time, so a member renaming
 * themselves updates every line they appear in. Same principle as posts:
 * never snapshot a name, so there's nothing here to go stale.
 */
export const memberEvents = sqliteTable(
  'member_events',
  {
    /**
     * Surrogate key, deliberately not `(circleId, epoch)`. A primary key
     * can't be nullable, and keying on epoch would foreclose ever writing
     * a *provisional* row — one inserted by the device performing the
     * action, before its entry has been appended and assigned an epoch.
     * Uniqueness of `(circleId, epoch)` is enforced by its own index
     * below, which is what actually makes replay idempotent.
     */
    id: integer('id').primaryKey({ autoIncrement: true }),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    /**
     * The relay-assigned epoch of the entry this row came from — unique
     * within a circle's meta namespace, so it is both the idempotency key
     * for replay (invariant 8) and the canonical ordering. Entries carry
     * no id of their own that reaches a handler; epoch is the only
     * per-entry identity there is.
     */
    epoch: integer('epoch').notNull(),
    /**
     * Local-only, unlike `EntryTypes` — this table is a disposable
     * projection rebuilt by replaying from epoch 0, so these values can
     * be renamed freely. Wire format cannot. `account_deleted` replaces
     * `removed` for a departure triggered by deleting the account, rather
     * than sharing `removed` plus a separate flag — same reasons `role`
     * splits `role_changed` by direction instead of a boolean.
     */
    kind: text('kind', { enum: ['created', 'added', 'removed', 'role_changed', 'account_deleted'] }).notNull(),
    /** Who it happened to. */
    subjectPublicKey: text('subject_public_key').notNull(),
    /**
     * Who did it — the entry's signer. Equal to `subjectPublicKey` when
     * the member acted on themselves: the founder's own `member_added`,
     * or leaving rather than being removed.
     */
    actorPublicKey: text('actor_public_key').notNull(),
    /** The role granted — `role_changed` only, null otherwise. */
    role: text('role', { enum: ['admin', 'member'] }),
    /**
     * The actor's clock, carried on the entry — never this device's
     * receipt time, or a device replaying from epoch 0 would date every
     * event to its own "now" and sort them all to the top of the feed.
     */
    occurredAt: integer('occurred_at').notNull(),
  },
  // The unique index is load-bearing, not just a lookup aid: it's what
  // `onConflictDoNothing` collides against, so replaying an entry updates
  // nothing instead of appending a duplicate event. It also covers
  // circleId-prefixed reads, so no separate index on circleId is needed.
  (t) => [uniqueIndex('member_events_circle_epoch').on(t.circleId, t.epoch)]
);

export const deviceProfile = sqliteTable(
  'device_profile',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    picture: blob('picture').$type<Uint8Array>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [check('device_profile_id_check', sql`${t.id} = 0`)]
);

export const circleInvites = sqliteTable(
  'circle_invites',
  {
    code: text('code').primaryKey(),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    createdByPublicKey: text('created_by_public_key').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('circle_invites_circle_id').on(t.circleId)]
);

export const posts = sqliteTable(
  'posts',
  {
    id: text('id').primaryKey(),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    caption: text('caption').notNull(),
    /**
     * The author's circle identity public key (hex, Ed25519) — the same
     * value a pulled entry's envelope is signed with, and the
     * `circleMembers` row key. Deliberately *not* a denormalized name or
     * avatar: both resolve live from `circleMembers` at render time, so a
     * member renaming themselves updates every post they ever made —
     * nothing about identity is copied here, only the pubkey that
     * resolves it.
     */
    authorPublicKey: text('author_public_key').notNull(),
    createdAt: integer('created_at').notNull(),
    /**
     * When this device last scrolled this post into view, or opened its
     * details screen — null means never. Backs the "has new comments"
     * marker: a comment only counts as unseen if it postdates this (see
     * getUnseenCommentPostIds), so viewing the post again always covers
     * whatever comments existed on it up to that moment.
     */
    lastViewedAt: integer('last_viewed_at'),
    /**
     * Whether this photo belongs in the circle's album — the archive view
     * every member shares, rather than only appearing in the feed as it
     * scrolls past. Chosen when posting and changeable afterwards (see
     * set-album-visibility.ts). Defaults true so a row that predates the
     * column, or an entry whose payload lacks the field, reads as
     * included rather than silently vanishing from the album.
     */
    inAlbum: integer('in_album', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [index('posts_circle_id').on(t.circleId)]
);

/**
 * Every encrypted blob this device knows about but may not hold yet —
 * post photos and circle cover photos alike. Modelled as its own table
 * because a blob has a lifecycle its owner doesn't: where to fetch it
 * from, whether it's arrived, and what to do about it if it hasn't. A
 * pulled post exists locally the moment its log entry is applied; its
 * bytes arrive later, out of band (see photo-queue.ts), so "post" and
 * "bytes of that post" are genuinely two things with two states.
 *
 * Keyed by `(circleId, entryId)` because that's how the relay itself
 * addresses blobs — GET /v1/circles/{syncId}/entries/{entryId}/blob — so
 * one download queue and one backoff policy serve every kind, and a
 * future kind (member avatars, at `{syncId}/avatar/{pubkey}`) is a new
 * `kind` value rather than a new table.
 *
 * Rows are created two ways, and both go through here rather than one
 * path bypassing it: locally-created content inserts `status: 'fetched'`
 * with bytes already in hand, and pulled content inserts
 * `status: 'pending'` with `bytes: null`.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    /**
     * The blob's stable relay-side address within its circle. A post
     * photo's is its `postId` (the id `drainOutbox` uploads under); a
     * circle cover's is the literal `'cover'`. Deliberately not a URL —
     * download URLs are presigned and expire, so they can't be persisted.
     *
     * `(circleId, entryId)` is the primary key rather than a synthetic id
     * because it's exactly how the relay addresses the blob, so there's
     * no second identity to keep in sync — and it's what makes
     * re-applying an already-seen entry a no-op instead of a duplicate.
     */
    /**
     * The id this entry is appended under at the relay — passed straight
     * to `appendEntry`, which makes it the relay's idempotency key, and
     * for a post also its blob address (`{syncId}/{entryId}` in S3).
     *
     * For posts and comments it's the same id as the local row, so every
     * device ends up naming that content identically. For reactions it's
     * a fresh id per toggle that refers to nothing local: reusing one
     * would let the relay read a re-reaction as a retry of the removal
     * and drop it.
     */
    entryId: text('entry_id').notNull(),
    /**
     * What this blob is for — decides where the bytes get rendered once
     * they land, and is why the fetcher itself never has to care.
     */
    kind: text('kind', { enum: ['post_photo', 'circle_cover'] }).notNull(),
    /** Decrypted bytes, once downloaded. Null while status is 'pending'/'failed'. */
    bytes: blob('bytes').$type<Uint8Array>(),
    /**
     * sha256 of the decrypted bytes, from the owning entry's *signed*
     * payload (see create-post.ts) — what verifies a download, since an
     * entry's signature can't cover a blob uploaded separately. '' when
     * nothing signed a hash for it (a circle cover, today).
     */
    hash: text('hash').notNull(),
    /** Which content-key version decrypts the blob — the version its entry used. */
    keyVersion: integer('key_version').notNull(),
    status: text('status', { enum: ['pending', 'fetched', 'failed'] }).notNull(),
    fetchAttempts: integer('fetch_attempts').notNull().default(0),
    /** Epoch ms before which a failed download won't be retried; null = eligible now. */
    nextAttemptAt: integer('next_attempt_at'),
    /**
     * When the owning content was created, copied here so the download
     * queue can order by recency without joining anything — see
     * `getFetchableAttachments`, the hottest query in the photo engine.
     */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.circleId, t.entryId] }), index('attachments_circle_id').on(t.circleId)]
);

export const postReactions = sqliteTable(
  'post_reactions',
  {
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /**
     * The reacting member's circle identity public key (hex, Ed25519) —
     * same identifier posts and comments use. It was `memberId`, which
     * is self-assigned per device and never travels on the wire, so a
     * synced reaction could not be attributed anywhere but its author's
     * own phone.
     */
    authorPublicKey: text('author_public_key').notNull(),
    /**
     * One grapheme cluster (a single emoji, however many UTF-16 code
     * units that takes for ZWJ sequences/skin tones/flags) — not
     * validated at the schema level; callers are responsible for that.
     */
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // One row per (post, author, emoji) — reacting again with the same
    // emoji is a toggle-off (delete the row), not a duplicate; the same
    // member can still hold several different emoji on one post.
    primaryKey({ columns: [t.postId, t.authorPublicKey, t.emoji] }),
    index('post_reactions_post_id').on(t.postId),
  ]
);

/**
 * Strict local ordering for locally-created content awaiting push to the
 * relay. `sequenceNum` (not `createdAt`) is what
 * `drainOutbox` pushes in order: a DB-assigned autoincrement is gap-free
 * and unambiguous by construction, where comparing timestamps across
 * (eventually several) locally-originated entry types would not be.
 * `epoch` stays null until the relay confirms the push.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    sequenceNum: integer('sequence_num').primaryKey({ autoIncrement: true }),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    entryType: text('entry_type', {
      enum: [
        'post',
        'comment',
        'reaction',
        'member_added',
        'profile_update',
        'member_removed',
        'role_change',
        'key_rotation',
        'cover_photo_set',
        'circle_renamed',
        'album_visibility',
        'post_delete',
        'push_enabled',
        'circle_deleted',
        'account_deleted',
      ],
    }).notNull(),
    /**
     * The id this entry is appended under at the relay — passed straight
     * to `appendEntry`, which makes it the relay's idempotency key, and
     * for a post also its blob address (`{syncId}/{entryId}` in S3).
     *
     * For posts and comments it's the same id as the local row, so every
     * device ends up naming that content identically. For reactions it's
     * a fresh id per toggle that refers to nothing local: reusing one
     * would let the relay read a re-reaction as a retry of the removal
     * and drop it.
     */
    entryId: text('entry_id').notNull(),
    /**
     * The exact ciphertext `drainOutbox` will POST as-is — built and
     * encrypted once, at enqueue time, not re-derived from `posts` when
     * the push actually happens. Two reasons that matters: a retry must
     * send byte-for-byte the same thing it did the first time (the
     * relay's idempotency is keyed on entryId, not payload — if a retry's
     * bytes differed, the relay would silently keep the first attempt's
     * content and drop the retry's), and a locally-created row can be
     * queued for a while before it actually goes out, during which
     * `posts` itself could in principle change under it.
     */
    encryptedMeta: blob('encrypted_meta').$type<Uint8Array>().notNull(),
    /**
     * Decoupled from `epoch` on purpose: today the two always move
     * together (pending -> synced, right when epoch is first set), but a
     * separate status leaves room for a later 'failed' state — a
     * permanently-failed push and a not-yet-attempted one would otherwise
     * both just look like `epoch IS NULL`, with no way to tell them apart.
     */
    status: text('status', { enum: ['pending', 'synced'] }).notNull(),
    epoch: integer('epoch'),
    /**
     * A blob this entry's push should delete once the entry itself has
     * landed — the deleted post's id, for a `post_delete`. Null for
     * everything else, which is nearly every row.
     *
     * Not `entryId`: a deletion is its own entry with its own id (the
     * post's is already taken at the relay, where entryId is the
     * idempotency key), so the blob's address has nowhere else to ride.
     * Sitting on the outbox row is what makes the deletion retriable —
     * it happens whenever the queue drains, which is what lets a photo
     * be deleted offline.
     */
    blobEntryId: text('blob_entry_id'),
    /**
     * How this entry must move the relay's authority set when it goes
     * out, for a `role_change` that promotes or demotes. Null for
     * everything else — including a demotion of someone the relay never
     * registered, which has no set entry to remove.
     *
     * Sitting on the row for the same reason `blobEntryId` does: it's
     * what lets the change be made offline. The relay commits the set
     * mutation and the entry together or not at all, so the drain has to
     * call a different endpoint for these rows and needs both halves to
     * build the request — the signature is over the action and target,
     * and is only produced at drain time, from a seed-derived key this
     * row never holds.
     */
    authorityAction: text('authority_action', { enum: ['add', 'remove'] }),
    /** The authority public key `authorityAction` applies to. Null whenever that is. */
    authorityTargetKey: text('authority_target_key'),
  },
  (t) => [index('outbox_circle_id').on(t.circleId)]
);

/**
 * One row per outstanding join request this device has submitted — lets a
 * "pending for Family Circle" screen survive the app being closed and
 * reopened before approval ever lands.
 * `id` is the requester-chosen id used both as the mailbox row's sort key
 * suffix and as the Keychain key for the matching ephemeral secret key
 * (see invite's `keystore.ts`'s `savePendingJoinKeypair`) — the secret key itself
 * never lives here. `status` is 'approved' only for the brief window
 * between decrypting the approval and finishing local setup; the row is
 * deleted entirely once that completes, so there's no long-lived "joined"
 * state to track here.
 */
export const pendingJoinRequests = sqliteTable('pending_join_requests', {
  id: text('id').primaryKey(),
  /**
   * The local circleId minted when the request was made, parked here
   * until approval. It has to exist that early because the requester's
   * identity is derived from it and its public half ships in the request
   * — and it has to be *remembered*, since deriving the same keypair
   * again later requires the same id (see server/README.md's identity
   * model). `completeJoin` adopts this as the circle row's `id`.
   */
  circleId: text('circle_id').notNull(),
  inviteCode: text('invite_code').notNull(),
  /** From the decrypted invite preview — shown on the pending screen without needing to re-fetch/re-decrypt it. */
  circleName: text('circle_name').notNull(),
  /** Also from the decrypted invite preview — the creator's self-reported display name, shown on the pending screen ("X needs to let you in"). Defaults to '' (matches profile?.name ?? '' elsewhere) so ALTER TABLE ADD COLUMN stays valid against existing local rows. */
  createdByName: text('created_by_name').notNull().default(''),
  /**
   * Also from the decrypted invite preview — the invite creator's own
   * circle-identity public key (hex, Ed25519), kept locally so a later
   * approval's signature can be verified against it without a second
   * fetch. See `JoinApprovalEnvelope`'s doc comment for why this matters:
   * without it, any existing member who knows the invite code could forge
   * a working approval, not just this invite's actual creator.
   */
  createdByPublicKey: text('created_by_public_key').notNull(),
  /** Hex-encoded X25519 public key; the matching secret key is in Keychain, never here. */
  ephemeralPublicKey: text('ephemeral_public_key').notNull(),
  submittedAt: integer('submitted_at').notNull(),
  status: text('status', { enum: ['pending', 'approved'] }).notNull().default('pending'),
});

export const postComments = sqliteTable(
  'post_comments',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /**
     * The author's circle identity public key (hex, Ed25519) — the same
     * identifier posts use, and for the same reason: it is what a synced
     * entry's signature is verified against, and the `circleMembers` row
     * key. Replaced `memberId` + `authorName`, neither of which could
     * survive syncing — `memberId` is self-assigned per device and never
     * travels on the wire, and a denormalized name froze whatever the
     * author was called at the time (literally "You" when they had no
     * profile name yet). Both now resolve live from the roster, so
     * renaming yourself updates every comment you ever made.
     */
    authorPublicKey: text('author_public_key').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('post_comments_post_id').on(t.postId)]
);
