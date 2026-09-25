import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useJustJoinedRows } from '@/features/feed/components/just-joined-row';
import { usePendingRequestRows } from '@/features/feed/components/pending-request-row';
import { usePostRows } from '@/features/feed/components/post-row';
import { useRosterChangeRows } from '@/features/feed/components/roster-change-row';
import { i18n } from '@/core/i18n/i18n';
import { useLanguage } from '@/core/i18n/use-language';
import { buildFeedRows, type FeedRow, type FeedRows } from '@/features/feed/components/rows';
import {
  loadCircleFeedMeta,
  loadCircleFeedPage,
  type CircleFeedMeta,
  type FeedCursor,
  type FeedPostView,
} from '@/features/feed/usecases/circle-feed';
import type { MemberEvent } from '@/features/feed/usecases/group-member-events';
import { onPhotoFetched } from '@/core/photo/photo-events';
import { showError } from '@/core/services/messages';
import { nudgePhotoQueue } from '@/core/photo/photo-queue';
import { syncCircles } from '@/core/sync/sync-circles';

/**
 * Merges a page's activity into what's already loaded. Pages necessarily
 * overlap — loadCircleFeedPage has no upper bound to fetch a tight window
 * with (see its own comment) — so this dedupes by id and restores
 * newest-first order, which groupMemberEvents depends on.
 */
function mergeEvents(current: MemberEvent[], next: MemberEvent[]): MemberEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of next) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.occurredAt - a.occurredAt);
}

export type UseCircleFeedOptions = {
  /** Whether to offer the fresh-joiner banner at all — hidden anyway once there are posts. */
  justJoined?: boolean;
};

export type CircleFeedController = {
  /** Everything to render, in order. The screen needs nothing else about the feed. */
  rows: FeedRow[];
  circleName: string;
  memberCount: number;
  /** Whether the first read has resolved — an empty `rows` before this is "still loading", not "no posts". */
  loaded: boolean;
  refreshing: boolean;
  /** Whether an older page exists to fetch — see `loadMore`. */
  hasMore: boolean;
  /** A page fetch is already in flight, for the footer spinner. */
  loadingMore: boolean;
  /** Fetches the next page and appends it — for the list's `onEndReached`. No-ops without a next page or while one's already in flight. */
  loadMore: () => Promise<void>;
  /** Re-read from disk — for the focus effect. Starts back over at the first page. */
  reload: () => Promise<void>;
  /** Sync, then re-read — for pull-to-refresh. */
  refresh: () => Promise<void>;
};

/** Everything paginated so far, accumulated across `loadMore` calls. */
type LoadedFeed = {
  posts: FeedPostView[];
  events: MemberEvent[];
  cursor: FeedCursor | null;
};

/**
 * One circle's feed, composed from its row kinds.
 *
 * This owns only what more than one kind reads — the loaded feed — plus
 * the list saying which kinds exist and in what pinned order. Each kind's
 * own hook owns its behaviour and anything private to it: join requests
 * keep their list and in-flight flag there rather than adding three
 * fields here.
 *
 * A new kind of row is a new module and one line in `adapters`. Nothing
 * else in the feed changes, and nothing here grows a branch.
 */
export function useCircleFeed(circleId: string, options: UseCircleFeedOptions): CircleFeedController {
  const [meta, setMeta] = useState<CircleFeedMeta | null>(null);
  const [feed, setFeed] = useState<LoadedFeed | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  /** The one thing a post row can't do for itself — it doesn't hold the feed. */
  const patchPost = useCallback((postId: string, change: Partial<FeedPostView>) => {
    setFeed((current) =>
      current
        ? { ...current, posts: current.posts.map((view) => (view.post.id === postId ? { ...view, ...change } : view)) }
        : current,
    );
  }, []);

  // Every kind produces `FeedRow[]` from the slice it is handed, so the
  // mapping below is a flat concatenation and nothing else.
  /**
   * Holds whatever the row kinds currently are, so `reload` can fan out to
   * them without depending on them. `sources` changes identity on every
   * load — a row kind's memo depends on the slice it was handed, and a
   * fresh `loadCircleFeed` hands it a fresh array — so a dependency here
   * would change `reload`'s identity after every load, re-fire the
   * screen's focus effect (which depends on `reload`), and load again: a
   * loop that never settles. It also lets `reload` be defined before the
   * kinds that need to call it.
   */
  const sourcesRef = useRef<FeedRows[]>([]);

  const reload = useCallback(async () => {
    if (!circleId) return;
    const freshMeta = await loadCircleFeedMeta(circleId);
    setMeta(freshMeta);
    const page = await loadCircleFeedPage(circleId, freshMeta, null);
    setFeed({ posts: page.posts, events: page.events, cursor: page.nextCursor });
    // Whichever kinds own state the feed's read doesn't cover refresh it
    // themselves — this doesn't need to know which those are.
    sourcesRef.current.forEach((source) => source.reload?.());
  }, [circleId]);

  /**
   * Appends the next page rather than replacing the feed — unlike
   * `reload`, which always starts back over at the first page. No-ops
   * quietly rather than throwing: `onEndReached` can fire more than once
   * before state catches up, and there's nothing to show for a failure
   * beyond what's already on screen.
   */
  const loadMore = useCallback(async () => {
    if (!circleId || !meta || !feed || feed.cursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadCircleFeedPage(circleId, meta, feed.cursor);
      setFeed((current) =>
        current
          ? { ...current, posts: [...current.posts, ...page.posts], events: mergeEvents(current.events, page.events), cursor: page.nextCursor }
          : current,
      );
    } catch (err) {
      console.error('Failed to load more of the feed', err);
    } finally {
      setLoadingMore(false);
    }
  }, [circleId, meta, feed, loadingMore]);

  // A photo landing while its placeholder is on screen patches that one
  // row rather than reloading — a backlog of many photos landing one by
  // one must not mean a feed reload apiece.
  useEffect(
    () =>
      onPhotoFetched((event) => {
        if (event.circleId === circleId) patchPost(event.postId, { photoUri: event.uri });
      }),
    [circleId, patchPost],
  );

  const requests = usePendingRequestRows({ circleId, ownIsAdmin: meta?.ownIsAdmin ?? false, onRosterChanged: reload });
  const justJoined = useJustJoinedRows({ justJoined: options.justJoined ?? false, postCount: feed?.posts.length ?? 0 });
  const language = useLanguage();
  const posts = usePostRows({
    circleId,
    patchPost,
    posts: feed?.posts ?? [],
    profile: meta?.profile ?? null,
    ownPublicKey: meta?.ownPublicKey ?? null,
    ownIsAdmin: meta?.ownIsAdmin ?? false,
    language,
  });
  // The only other thing roster changes share a timeline with — see
  // roster-change-row.tsx for why a post's own timestamp is all it needs.
  const postTimestamps = useMemo(() => (feed?.posts ?? []).map((view) => view.post.createdAt), [feed?.posts]);
  const rosterChanges = useRosterChangeRows({
    events: feed?.events ?? [],
    postTimestamps,
    ownPublicKey: meta?.ownPublicKey ?? null,
    language,
  });

  /**
   * The mapping, and the only place that knows which kinds a circle feed
   * has. Order here is the pinned order; anything carrying a time sorts by
   * it instead. Adding a kind is one hook call and one entry.
   */
  const sources: FeedRows[] = useMemo(
    () => [requests, justJoined, posts, rosterChanges],
    [requests, justJoined, posts, rosterChanges],
  );
  // In an effect, not during render: a discarded render would leave
  // `reload` fanning out to sources that never mounted.
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  const rows = useMemo(() => buildFeedRows(sources.flatMap((source) => source.rows)), [sources]);

  /**
   * Sync this circle, then re-read. Only the log pass is awaited: photos
   * are nudged and left to their own queue, so the spinner ends when
   * captions and roster are current rather than when the last photo
   * finishes downloading.
   */
  const refresh = useCallback(async () => {
    if (!circleId) return;
    setRefreshing(true);
    try {
      // Account-wide now — the relay owns membership, so a sync pass is
      // every circle at once rather than one this screen could target.
      // Forced: an explicit pull is the user saying the relay's version
      // hints aren't trusted, so this walks regardless of what moved.
      await syncCircles({ force: true });
      nudgePhotoQueue();
    } catch (err) {
      // Reported, then re-read below anyway: a pull that couldn't reach
      // the relay still shows whatever landed last, rather than replacing
      // stale-but-valid content with a failure.
      console.error('Failed to sync on pull-to-refresh', err);
      showError(i18n.t('feed.refreshFailed'));
    } finally {
      await reload().catch((err) => console.error('Failed to reload the feed', err));
      setRefreshing(false);
    }
  }, [circleId, reload]);

  return {
    rows,
    circleName: meta?.circleName ?? '',
    memberCount: meta?.memberCount ?? 0,
    loaded: feed !== null,
    refreshing,
    hasMore: feed !== null && feed.cursor !== null,
    loadingMore,
    loadMore,
    reload,
    refresh,
  };
}
