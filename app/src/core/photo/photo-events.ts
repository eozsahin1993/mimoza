/**
 * Photos land on their own queue after screens have already read the
 * database once on focus. The queue pings here per fetched photo, of
 * whichever kind, and subscribers patch just the one row rather than
 * reloading — a backlog landing one by one must not mean a screen
 * reload apiece.
 */

export type PhotoFetched =
  | { kind: 'post'; circleId: string; postId: string; uri: string }
  | { kind: 'cover'; circleId: string; uri: string }
  | { kind: 'profilePicture'; accountId: string; uri: string };

type Listener = (event: PhotoFetched) => void;

const listeners = new Set<Listener>();

/** Returns the unsubscribe. */
export function onPhotoFetched(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyPhotoFetched(event: PhotoFetched): void {
  listeners.forEach((listener) => listener(event));
}
