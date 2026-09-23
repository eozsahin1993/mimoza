import { setNotifyLevel, type NotifyLevel } from '@/features/push-notifications/services/notify-level-relay';

export type { NotifyLevel };

/**
 * Which notifications one circle sends this account. Everything the old
 * mask-and-fanout-hash model needed — a category bitmask synced to the
 * relay, a separate silence flag, a staleness check against the content
 * key — collapsed into this one relay-stored field once the relay started
 * composing push itself: `notifyLevel` is `all | comments | photos |
 * none`, `none` is what silencing now is, and there is nothing left for a
 * device to keep in sync, so nothing to go stale.
 *
 * No local-first write here on purpose: this slice doesn't own the local
 * circles row notifyLevel would read from — whatever reads it back is
 * whoever's rewriting the circle details screen against the new schema.
 */
export async function setCircleNotifyLevel(circleId: string, accountId: string, level: NotifyLevel): Promise<void> {
  await setNotifyLevel(circleId, accountId, level);
}
