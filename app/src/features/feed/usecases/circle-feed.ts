import {
  countMembers,
  getAttachment,
  getCircle,
  getComments,
  getFeed,
  getMember,
  listActivitySince,
  listEveryMemberSeen,
  getProfile,
  summarise,
  type Post,
  type Profile,
  type ReactionSummary,
} from '@/data/db';
import { toMemberEvents, isMembershipEvent, type MemberEvent } from '@/features/feed/usecases/group-member-events';
import { ensurePhotoUri, writePhotoFile } from '@/core/photo/photo-cache';

/** The one comment a card shows, and the count behind its "Show all" link. */
export type CommentSummary = { latest: Awaited<ReturnType<typeof getComments>>[number] | null; total: number };

/**
 * One page's own position: the oldest post it carried, or null at the
 * very start. The id half breaks ties among posts sharing a createdAt —
 * see getFeed in data/db/posts.ts, which this passes straight through to.
 */
export type FeedCursor = { createdAt: number; id: string };

/** One post with everything the feed draws around it, gathered in one pass. */
export type FeedPostView = {
  post: Post;
  /** Resolved live from the roster, same as an activity row's actor — posts carry only authorId. */
  authorName: string;
  photoUri?: string;
  /** Undefined only once the photo has actually arrived — see missingPhotoFor. Absent post-and-all when there never was one. */
  photoStatus?: string;
  reactions: ReactionSummary;
  comments: CommentSummary;
};

/** Circle-level facts a page doesn't repeat — read once when the feed is (re)opened. */
export type CircleFeedMeta = {
  circleName: string;
  memberCount: number;
  profile: Profile | null;
  /**
   * The reader's own account id. Named ownPublicKey for the row kinds
   * that already compare against it (roster changes, posts) — it is an
   * account id now, not a key, but the comparison is the same either way
   * and renaming it is a bigger change than this phase's read-layer port.
   */
  ownPublicKey: string | null;
  /** Whether the reader is an admin — with authorship, decides who may re-file a photo. */
  ownIsAdmin: boolean;
  circleCreatedAt: number;
};

export type CircleFeedPage = {
  posts: FeedPostView[];
  events: MemberEvent[];
  /** Pass this back in for the next page; null once every post is loaded. */
  nextCursor: FeedCursor | null;
  hasMore: boolean;
};

export const FEED_PAGE_SIZE = 10;

/**
 * Circle-level facts, read once per feed open — never touches the network,
 * same as loadCircleFeedPage.
 */
export async function loadCircleFeedMeta(circleId: string): Promise<CircleFeedMeta> {
  const [circle, memberCount, profile] = await Promise.all([getCircle(circleId), countMembers(circleId), getProfile()]);
  const ownMember = profile ? await getMember(circleId, profile.accountId) : null;

  return {
    circleName: circle?.name ?? '',
    memberCount,
    profile,
    ownPublicKey: profile?.accountId ?? null,
    ownIsAdmin: ownMember?.role === 'admin',
    circleCreatedAt: circle?.createdAt ?? 0,
  };
}

/**
 * One page of the wall: `FEED_PAGE_SIZE` posts older than `cursor` (or
 * the newest page, given `null`), and the activity in between — the
 * relay-owned wall, read locally, no network. Sync writes to SQLite and
 * the screen renders what's there, so the two stay independent and a
 * slow relay can't stall a repaint.
 *
 * The activity floor mirrors the old member-events read: every event
 * down to this page's oldest post, not just this page's worth, since a
 * block only knows it's complete once every post that could split it is
 * known too (see groupMemberEvents). The very last page takes every
 * remaining event, with no floor at all.
 *
 * Returns data, not view models: no formatted timestamps, no data URIs.
 * Those are the screen's business, and keeping them out means this can
 * be tested without a renderer.
 */
export async function loadCircleFeedPage(
  circleId: string,
  meta: Pick<CircleFeedMeta, 'ownPublicKey'>,
  cursor: FeedCursor | null,
): Promise<CircleFeedPage> {
  const posts = await getFeed(circleId, FEED_PAGE_SIZE + 1, cursor ?? undefined);
  const hasMore = posts.length > FEED_PAGE_SIZE;
  const page = hasMore ? posts.slice(0, FEED_PAGE_SIZE) : posts;
  const oldestPost = page[page.length - 1];

  // Down to this page's own floor when there's another page after it (so
  // a later block knows it's complete — see groupMemberEvents), or every
  // remaining event on the last page, which has nothing left to split.
  // Necessarily overlaps an earlier page's own fetch rather than a tight
  // window — listActivitySince has no upper bound to ask for one — so
  // the caller accumulating across pages dedupes by id (see
  // use-circle-feed.ts).
  const floor = hasMore && oldestPost ? oldestPost.createdAt : 0;
  const rawActivity = await listActivitySince(circleId, floor);
  const members = await membersByAccount(circleId);
  const events = toMemberEvents(rawActivity.filter(isMembershipEvent), (accountId) => members.get(accountId) ?? null);

  const photos = await resolvePhotos(circleId, page);
  const commentsByPost = await commentSummaries(page);
  // No batched read for reactions yet (summarise is per post, unlike
  // comments/photos above) — FEED_PAGE_SIZE queries per page until one
  // exists.
  const posts_ = await Promise.all(
    page.map(async (post) => ({
      post,
      authorName: members.get(post.authorId) ?? '',
      ...photos.get(post.id),
      reactions: meta.ownPublicKey ? await summarise(post.id, meta.ownPublicKey) : { counts: {}, total: 0, iReacted: false },
      comments: commentsByPost.get(post.id) ?? { latest: null, total: post.commentCount },
    })),
  );

  return {
    events,
    nextCursor: hasMore && oldestPost ? { createdAt: oldestPost.createdAt, id: oldestPost.id } : null,
    hasMore,
    posts: posts_,
  };
}

/** The account-id -> name map both actor and subject resolution draw from — includes members who have since left. */
async function membersByAccount(circleId: string): Promise<Map<string, string>> {
  const members = await listEveryMemberSeen(circleId);
  return new Map(members.map((member) => [member.accountId, member.name]));
}

/**
 * The preview on every post in the page, in one getComments call across
 * all of their recentCommentIds instead of one call per post.
 */
async function commentSummaries(posts: Post[]): Promise<Map<string, CommentSummary>> {
  const allIds = posts.flatMap((post) => JSON.parse(post.recentCommentIds) as string[]);
  const comments = await getComments(allIds);

  const byPost = new Map<string, typeof comments>();
  for (const comment of comments) {
    const list = byPost.get(comment.postId);
    if (list) list.push(comment);
    else byPost.set(comment.postId, [comment]);
  }

  return new Map(
    posts.map((post) => {
      const latest = (byPost.get(post.id) ?? []).reduce<(typeof comments)[number] | null>(
        (newest, comment) => (!newest || comment.createdAt > newest.createdAt ? comment : newest),
        null,
      );
      return [post.id, { latest, total: post.commentCount }];
    }),
  );
}

/**
 * Resolves each post's photo to a cached `file://` path, and the status
 * behind it when there isn't one yet. Only a post whose file is missing
 * — first sight, or a cache the OS cleared — costs a read of its bytes
 * and an attachment lookup; everything else is an existence check, which
 * is what makes re-entering the feed cheap.
 *
 * Whether a post has a photo at all isn't a column on posts — it's
 * whichever ones sync recorded an attachment row for (see schema.ts's
 * attachments doc comment), pending or not. No row at all means no
 * photo, not "still arriving" — a caption-only post.
 */
async function resolvePhotos(circleId: string, posts: Post[]): Promise<Map<string, { photoUri?: string; photoStatus?: string }>> {
  const resolved = new Map<string, { photoUri?: string; photoStatus?: string }>();

  for (const post of posts) {
    const cached = ensurePhotoUri(circleId, post.id, () => null);
    if (cached) {
      resolved.set(post.id, { photoUri: cached });
      continue;
    }

    const attachment = await getAttachment(circleId, post.id);
    if (!attachment) continue;
    if (attachment.bytes) {
      resolved.set(post.id, { photoUri: writePhotoFile(circleId, post.id, attachment.bytes) });
    } else {
      resolved.set(post.id, { photoStatus: attachment.status });
    }
  }

  return resolved;
}
