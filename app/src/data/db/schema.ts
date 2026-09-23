import { index, integer, primaryKey, sqliteTable, text, blob } from 'drizzle-orm/sqlite-core';

/**
 * What this device keeps locally is a projection shaped for the screens,
 * not a mirror of the relay's tables.
 *
 * Three rules keep it honest. The wall depends only on rows a sync keeps
 * complete: circles, circleMembers, activity and posts. The relay-owned
 * half of a post is written from relay data and never by a local action,
 * so there is one writer and nothing to reconcile; optimistic state is
 * derived at read time from the outbox. Rows fetched on demand,
 * postComments beyond the preview and postReactions, are a partial cache
 * and say so through posts.childrenFetchedAt.
 */

export const circles = sqliteTable('circles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull().default('member'),
  notifyLevel: text('notify_level').notNull().default('all'),
  /** The circle's current content key, and the roster's version. A sync compares both against its own. */
  keyVersion: integer('key_version').notNull().default(1),
  rosterVersion: integer('roster_version').notNull().default(0),
  /** Relay-stamped time of the last entry, so a sync can skip a circle with nothing new. */
  lastEntryAt: integer('last_entry_at').notNull().default(0),
  /** The cover's content hash. Bytes live in attachments under the same id. */
  coverId: text('cover_id'),
  /** This account replaced its keypair, so the keys here are unreadable until a member reseals them. */
  needsRewrap: integer('needs_rewrap', { mode: 'boolean' }).notNull().default(false),
  /**
   * Opaque relay cursors, one per direction. Only the relay reads them;
   * this device stores and returns them.
   */
  postsForwardCursor: text('posts_forward_cursor'),
  postsBackwardCursor: text('posts_backward_cursor'),
  activityCursor: text('activity_cursor'),
  createdAt: integer('created_at').notNull(),
  /** The unread badge's floor: everything older than this has been seen. */
  lastViewedAt: integer('last_viewed_at').notNull().default(0),
  /** Set when this device leaves, so already-synced posts stay as a local archive. */
  leftAt: integer('left_at'),
});

/**
 * One row per member ever seen. Departures set leftAt rather than
 * deleting, so a post or a reaction by someone who has gone still
 * resolves to a name.
 */
export const circleMembers = sqliteTable(
  'circle_members',
  {
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    name: text('name').notNull().default(''),
    /**
     * This member's picture in this circle, and the content key version
     * it was sealed under. A picture is circle content, so the same
     * person has a different one per circle; bytes live in attachments.
     */
    avatarId: text('avatar_id'),
    avatarKeyVersion: integer('avatar_key_version'),
    /** X25519, what this member's copy of a content key is sealed to. */
    publicKey: text('public_key').notNull().default(''),
    role: text('role').notNull().default('member'),
    joinedAt: integer('joined_at').notNull().default(0),
    leftAt: integer('left_at'),
    needsRewrap: integer('needs_rewrap', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.circleId, t.accountId] })]
);

/**
 * What happened to the circle itself, written by the relay and
 * interleaved with posts on the wall. subjectName is the name at the
 * time, so someone who has left stays attributable.
 */
export const activity = sqliteTable(
  'activity',
  {
    id: text('id').primaryKey(),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    actorId: text('actor_id').notNull(),
    subjectId: text('subject_id'),
    subjectName: text('subject_name'),
    receivedAt: integer('received_at').notNull(),
  },
  (t) => [index('activity_circle_received').on(t.circleId, t.receivedAt)]
);

export const posts = sqliteTable(
  'posts',
  {
    id: text('id').primaryKey(),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull(),
    caption: text('caption').notNull().default(''),
    /** The author's own clock, from inside the ciphertext: what the wall sorts on. */
    createdAt: integer('created_at').notNull(),
    /** The relay's clock: what a cursor walks. */
    receivedAt: integer('received_at').notNull(),
    inAlbum: integer('in_album', { mode: 'boolean' }).notNull().default(true),
    deletedAt: integer('deleted_at'),
    lastViewedAt: integer('last_viewed_at'),
    /**
     * When this post's comments and reactions were last fetched. Null
     * means never. Compared against updatedAt to decide whether opening
     * the post needs a call at all.
     */
    childrenFetchedAt: integer('children_fetched_at'),

    /**
     * Everything below is the relay's, replaced wholesale by every sync
     * and never written by a local action. Optimistic state is derived
     * at read time from the outbox, so there is nothing here to
     * reconcile when an operation lands.
     */
    updatedAt: integer('updated_at').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    /**
     * Emoji to count, as JSON. The relay counts by an opaque tag; the
     * tag is decoded here on the way in, while the keys are at hand, so
     * rendering never touches one.
     */
    reactionCounts: text('reaction_counts').notNull().default('{}'),
    /**
     * Reactions whose tag this device cannot name yet, made under a key
     * version it has not been given. They count toward the total and
     * resolve themselves on the next sync after a reseal.
     */
    unnamedReactions: integer('unnamed_reactions').notNull().default(0),
    /**
     * The newest comments the relay carries on the post row, by id. The
     * preview joins these from post_comments, which is also where the
     * "new comments" marker gets its timestamp.
     */
    recentCommentIds: text('recent_comment_ids').notNull().default('[]'),
    /** What this account did, as a filled state. Which emoji comes from the children fetch. */
    iReacted: integer('i_reacted', { mode: 'boolean' }).notNull().default(false),
    iCommented: integer('i_commented', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('posts_circle_created').on(t.circleId, t.createdAt)]
);

/**
 * Every encrypted blob this device knows about but may not hold yet. A
 * blob has a lifecycle its owner does not: where to fetch it, whether it
 * has arrived, and what to do if it has not.
 *
 * Keyed the way the relay addresses it, so one queue and one backoff
 * serve post photos, covers and member pictures alike.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    /**
     * The rest of the relay's key after the circle: a post's id, or
     * `cover/<coverId>`, or `avatar/<accountId>/<avatarId>`.
     */
    entryId: text('entry_id').notNull(),
    kind: text('kind').notNull(),
    bytes: blob('bytes').$type<Uint8Array>(),
    /** The hash inside the ciphertext, checked against the bytes fetched. */
    hash: text('hash'),
    keyVersion: integer('key_version'),
    status: text('status').notNull().default('pending'),
    fetchAttempts: integer('fetch_attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.circleId, t.entryId] })]
);

/**
 * Filled three ways: the preview the relay carries on every post, the
 * children fetch when a post is opened, and this device's own comments,
 * inserted pending beside their outbox row.
 */
export const postComments = sqliteTable(
  'post_comments',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    circleId: text('circle_id').notNull(),
    authorId: text('author_id').notNull(),
    /** Reserved: the relay stores it and does not act on it yet. */
    parentCommentId: text('parent_comment_id'),
    body: text('body').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
    /** Written locally and not yet confirmed by a sync. */
    pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('post_comments_post_created').on(t.postId, t.createdAt)]
);

/**
 * One row per member per emoji, filled when a post is opened and by this
 * device's own writes. A sync carries counts, not names, so this is a
 * partial cache and posts.childrenFetchedAt says how partial.
 *
 * The emoji is decoded once on the way in, while the key is at hand.
 */
export const postReactions = sqliteTable(
  'post_reactions',
  {
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    circleId: text('circle_id').notNull(),
    accountId: text('account_id').notNull(),
    tag: text('tag').notNull(),
    emoji: text('emoji').notNull().default(''),
    keyVersion: integer('key_version'),
    createdAt: integer('created_at').notNull(),
    /**
     * Queued locally and not yet confirmed: 'add' or 'remove'. The card
     * sums the post's counts plus adds minus removes, so a tap shows
     * immediately and corrects itself when the relay answers.
     */
    pendingOp: text('pending_op'),
  },
  (t) => [primaryKey({ columns: [t.postId, t.accountId, t.tag] })]
);

/** What a queued write is. Membership changes are direct calls, not these. */
export type OutboxOp =
  | 'post'
  | 'comment'
  | 'reaction'
  | 'unreact'
  | 'delete_post'
  | 'delete_comment'
  | 'set_visibility';

/**
 * Content writes queue here and drain in order. Membership operations do
 * not: they need the current roster anyway, so they are direct calls
 * that fail in front of the person who made them.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    circleId: text('circle_id').notNull(),
    op: text('op').$type<OutboxOp>().notNull(),
    postId: text('post_id'),
    entryId: text('entry_id'),
    /** The plaintext to seal at send time, as JSON. Sealed late, so a key rotation between queueing and sending is not a problem. */
    plaintext: text('plaintext').notNull().default('{}'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    lastError: text('last_error'),
    status: text('status').notNull().default('queued'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('outbox_circle_status').on(t.circleId, t.status)]
);

/** This device and the account behind it. One row. */
export const deviceProfile = sqliteTable('device_profile', {
  accountId: text('account_id').primaryKey(),
  name: text('name').notNull().default(''),
  /**
   * The original picture, kept locally so it can be sealed again for
   * each circle. There is no account-level avatar on the relay: a
   * picture is circle content, sealed to that circle's key.
   */
  picture: blob('picture').$type<Uint8Array>(),
  deviceId: text('device_id').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Asks to join, until the relay answers them. */
export const pendingRequests = sqliteTable('pending_requests', {
  circleId: text('circle_id').primaryKey(),
  inviteCode: text('invite_code').notNull(),
  circleName: text('circle_name').notNull().default(''),
  invitedByName: text('invited_by_name').notNull().default(''),
  submittedAt: integer('submitted_at').notNull(),
  status: text('status').notNull().default('pending'),
});
