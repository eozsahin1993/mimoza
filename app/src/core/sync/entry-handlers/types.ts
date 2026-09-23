import { getProfile } from '@/data/db';
import { reactionTagKey, reactionTagTable } from '@/core/crypto/reaction-tags';
import { getCircleKeyMap } from '@/core/services/keystore/circle-keys';
import type { Entry } from '@/features/post/services/post-relay';

/**
 * What every handler needs and none of them should look up per entry:
 * the keys a page might be encrypted under, and the tag table derived
 * from them.
 *
 * The relay authorizes writes now, so a handler is parse, decrypt,
 * apply — there are no predicates here and no signature to check.
 */
export type EntryContext = {
  circleId: string;
  /** This account, for the rows that record what you yourself did. */
  accountId: string;
  keys: Record<number, Uint8Array>;
  /** What every reaction tag in this circle is made with. Never rotates. */
  tagKey: Uint8Array | null;
  /** Tag to emoji, for reading the relay's count map. */
  tags: Record<string, string>;
};

export type EntryHandler = (ctx: EntryContext, entry: Entry) => Promise<void>;

/** Null when this device holds no keys for the circle, or no profile yet: nothing can be applied. */
export async function entryContext(circleId: string): Promise<EntryContext | null> {
  const keys = await getCircleKeyMap(circleId);
  const profile = await getProfile();
  if (!keys || !profile) return null;
  const tagKey = reactionTagKey(circleId, keys);
  return { circleId, accountId: profile.accountId, keys, tagKey, tags: reactionTagTable(tagKey) };
}
