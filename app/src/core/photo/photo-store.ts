import { create } from 'zustand';

/**
 * Photos land on their own queue after screens have already read the
 * database once on focus. Each landing is written here, keyed the way a
 * screen addresses it, and whatever is showing that placeholder re-renders
 * on its own — a backlog landing one by one must not mean a screen reload
 * apiece, and no screen should have to subscribe and patch by hand.
 *
 * SQLite stays the truth. This holds only file URIs resolved since launch,
 * so it starts empty and a reader falls back to what its cold read found
 * (see use-photo-uri.ts for which of the two wins). `null` is a removal:
 * it has to beat that fallback, or a cleared picture would show again
 * from a stale prop. A deleted post gets no entry at all — its row goes
 * with it, so nothing is left to render either way.
 */
type Uri = string | null;

type PhotoStore = {
  profilePictures: Record<string, Uri>;
  postPhotos: Record<string, Uri>;
  covers: Record<string, Uri>;
};

const empty = (): PhotoStore => ({ profilePictures: {}, postPhotos: {}, covers: {} });

export const usePhotoStore = create<PhotoStore>()(empty);

export function postPhotoKey(circleId: string, postId: string): string {
  return `${circleId}/${postId}`;
}

export function setProfilePictureUri(accountId: string, uri: string): void {
  usePhotoStore.setState((s) => ({ profilePictures: { ...s.profilePictures, [accountId]: uri } }));
}

export function clearProfilePictureUri(accountId: string): void {
  usePhotoStore.setState((s) => ({ profilePictures: { ...s.profilePictures, [accountId]: null } }));
}

export function setPostPhotoUri(circleId: string, postId: string, uri: string): void {
  usePhotoStore.setState((s) => ({ postPhotos: { ...s.postPhotos, [postPhotoKey(circleId, postId)]: uri } }));
}

export function setCoverUri(circleId: string, uri: string): void {
  usePhotoStore.setState((s) => ({ covers: { ...s.covers, [circleId]: uri } }));
}

/** Forgets a circle's cover and every post photo under it — for a purge, whose files are gone too. */
export function clearCirclePhotos(circleId: string): void {
  const prefix = `${circleId}/`;
  usePhotoStore.setState((s) => {
    const { [circleId]: _cover, ...covers } = s.covers;
    const postPhotos = Object.fromEntries(Object.entries(s.postPhotos).filter(([key]) => !key.startsWith(prefix)));
    return { covers, postPhotos };
  });
}

export function resetPhotoStore(): void {
  usePhotoStore.setState(empty());
}

export function getPhotoStoreState(): PhotoStore {
  return usePhotoStore.getState();
}
