/**
 * A sync pass writes straight to SQLite with nothing watching for it —
 * a screen already mounted (not just focused) has no way to know its
 * data just moved. This is that notice: something finished in the
 * background, and a listener re-reads rather than waiting on a refocus
 * that might not come for a while.
 *
 * A plain emitter rather than a store like photo-store.ts: a single photo
 * landing is one keyed value a row can select, but a sync pass can touch
 * any number of circles at once, and every listener so far just wants
 * "something may have changed" to re-read its own slice whole.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** Returns the unsubscribe. */
export function onSyncCompleted(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifySyncCompleted(): void {
  listeners.forEach((listener) => listener());
}
