import { useState } from 'react';

import { postPhotoKey, usePhotoStore } from '@/core/photo/photo-store';

type Entry = string | null | undefined;

/**
 * Each hook selects one entry, so a row re-renders only when its own
 * picture changes, not when any picture does.
 *
 * Whichever of the two moved last wins: `initial` is what the screen's
 * cold read found, and a new cold read (a refocus) is at least as fresh
 * as anything in the store, since every writer lands in SQLite before
 * it lands here. Without that rule a store entry would shadow every
 * later read for the rest of the session, and the design would quietly
 * depend on every path that writes bytes also writing the store.
 */
function useLatest(entry: Entry, initial: string | undefined): string | undefined {
  const [seen, setSeen] = useState({ entry, initial, fromStore: entry !== undefined });

  let fromStore = seen.fromStore;
  if (entry !== seen.entry) fromStore = entry !== undefined;
  else if (initial !== seen.initial) fromStore = false;
  if (fromStore !== seen.fromStore || entry !== seen.entry || initial !== seen.initial) setSeen({ entry, initial, fromStore });

  // A removal is a value too: it beats the stale `initial` it arrived after.
  if (fromStore) return entry ?? undefined;
  return initial;
}

export function useProfilePictureUri(accountId: string | undefined, initial?: string): string | undefined {
  const entry = usePhotoStore((s) => (accountId ? s.profilePictures[accountId] : undefined));
  return useLatest(entry, initial);
}

export function usePostPhotoUri(circleId: string | undefined, postId: string | undefined, initial?: string): string | undefined {
  const entry = usePhotoStore((s) => (circleId && postId ? s.postPhotos[postPhotoKey(circleId, postId)] : undefined));
  return useLatest(entry, initial);
}

export function useCoverUri(circleId: string | undefined, initial?: string): string | undefined {
  const entry = usePhotoStore((s) => (circleId ? s.covers[circleId] : undefined));
  return useLatest(entry, initial);
}
