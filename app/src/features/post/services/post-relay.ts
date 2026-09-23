import { authorizedFetch, describeError } from '@/core/services/relay';

/**
 * Entries in a circle: the pages a sync walks, what hangs off one post,
 * and the writes that change any of it.
 *
 * Ciphertext crosses this boundary as base64. Cursors are opaque strings
 * the relay reads and this device only stores.
 */

/**
 * Where a post sits. The relay stores this as an opaque string and never
 * acts on it; these two values are the whole vocabulary.
 */
export const Visibility = { ALBUM: 'album', FEED: 'feed' } as const;

export type CommentEntry = {
  commentId: string;
  authorId: string;
  parentCommentId?: string;
  keyVersion: number;
  ciphertext?: string;
  receivedAt: number;
  deletedAt?: number;
};

export type ReactionEntry = {
  accountId: string;
  tag: string;
  keyVersion: number;
  /** `{emoji}`. The tag is what the relay counts by; this is what names it. */
  ciphertext?: string;
  receivedAt: number;
};

/**
 * One row of a page. A post carries its counts and what this account
 * itself did; an activity entry carries the event and who it was about.
 * Which fields are present depends on `type`.
 */
export type Entry = {
  entryId: string;
  type: 'post' | 'activity';
  authorId: string;
  receivedAt: number;

  keyVersion?: number;
  ciphertext?: string;
  hasBlob?: boolean;
  visibility?: string;
  commentCount?: number;
  /** Tag to count. The emoji behind a tag is resolved locally. */
  reactionCounts?: Record<string, number>;
  recentComments?: CommentEntry[];
  iReacted?: boolean;
  iCommented?: boolean;
  updatedAt?: number;
  deletedAt?: number;

  event?: string;
  subjectId?: string;
  subjectName?: string;
};

export type Page = {
  entries: Entry[];
  next?: string;
  prev?: string;
  more: boolean;
};

/**
 * One page of a stream. The cursor says which stream and where; passing
 * none starts at the newest.
 */
export async function walkEntries(
  circleId: string,
  type: 'post' | 'activity',
  cursor?: string,
  limit?: number
): Promise<Page> {
  const query = new URLSearchParams({ type });
  if (cursor) query.set('cursor', cursor);
  if (limit) query.set('limit', String(limit));

  const response = await authorizedFetch(`/v1/circles/${circleId}/entries?${query}`);
  if (!response.ok) throw new Error(await describeError(response, 'walking entries'));
  const body = (await response.json()) as Partial<Page>;
  return { entries: body.entries ?? [], next: body.next, prev: body.prev, more: body.more ?? false };
}

/** How many entries of a type the circle has, which is how a device knows it has caught up. */
export async function countEntries(circleId: string, type: 'post' | 'activity'): Promise<number> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/entries?type=${type}&count=1`);
  if (!response.ok) throw new Error(await describeError(response, 'counting entries'));
  const body = (await response.json()) as { count?: number };
  return body.count ?? 0;
}

/** Everything hanging off one post, fetched when it is opened. */
export async function getChildren(
  circleId: string,
  postId: string
): Promise<{ comments: CommentEntry[]; reactions: ReactionEntry[] }> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/entries/${postId}/children`);
  if (!response.ok) throw new Error(await describeError(response, 'reading a post'));
  const body = (await response.json()) as { comments?: CommentEntry[]; reactions?: ReactionEntry[] };
  return { comments: body.comments ?? [], reactions: body.reactions ?? [] };
}

/**
 * Writes. Each answers with the post it changed, in the same shape a
 * page carries, so the device that wrote it can replace its copy without
 * waiting for a sync.
 */
export async function putPost(
  circleId: string,
  post: { entryId: string; keyVersion: number; ciphertext: string; hasBlob?: boolean; visibility?: string }
): Promise<Entry> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(post),
  });
  if (!response.ok) throw new Error(await describeError(response, 'posting'));
  return (await response.json()) as Entry;
}

export async function addComment(
  circleId: string,
  postId: string,
  comment: { commentId: string; keyVersion: number; ciphertext: string; parentCommentId?: string }
): Promise<Entry> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/entries/${postId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(comment),
  });
  if (!response.ok) throw new Error(await describeError(response, 'commenting'));
  return (await response.json()) as Entry;
}

/** A tag is the emoji hashed under the circle's current content key; the relay counts by it and cannot read it. */
export async function react(
  circleId: string,
  postId: string,
  reaction: { tag: string; keyVersion: number; ciphertext: string }
): Promise<Entry> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/entries/${postId}/reactions/me`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reaction),
  });
  if (!response.ok) throw new Error(await describeError(response, 'reacting'));
  return (await response.json()) as Entry;
}

/** Keyed by tag, since a member may hold more than one reaction on a post. */
export async function unreact(circleId: string, postId: string, tag: string): Promise<Entry> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/entries/${postId}/reactions/${tag}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(await describeError(response, 'removing a reaction'));
  return (await response.json()) as Entry;
}

export async function deletePost(circleId: string, postId: string): Promise<Entry> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/entries/${postId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await describeError(response, 'deleting a post'));
  return (await response.json()) as Entry;
}

export async function deleteComment(circleId: string, postId: string, commentId: string): Promise<Entry> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/entries/${postId}/comments/${commentId}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(await describeError(response, 'deleting a comment'));
  return (await response.json()) as Entry;
}

export async function setVisibility(circleId: string, postId: string, visibility: string): Promise<Entry> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/entries/${postId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'changing visibility'));
  return (await response.json()) as Entry;
}
