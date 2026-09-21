import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleMembers, insertOutboxEntry, OutboxStatuses, setCirclePushKeyVersion, setMemberPushRoutingId } from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/core/sync/log-entry';
import { type PushCategory } from '@/features/push-notifications/usecases/push-categories';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { generateUUID } from '@/core/crypto/primitives';
import { derivePushRoutingId } from '@/core/crypto/identity';
import { derivePushDeviceId, derivePushFanoutHash, derivePushFanoutToken } from '@/features/push-notifications/crypto';
import { getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { getPushDeviceSecret } from '@/features/push-notifications/keystore';
import { deletePushDevice, deletePushRouting, putPushDevice, putPushPrefs } from '@/features/push-notifications/services/relay';

/**
 * Registering this account and device for a circle's notifications, and
 * publishing where to reach them.
 *
 * Two halves that must both happen: the relay learns where to deliver
 * (`putPushPrefs`/`putPushDevice`), and the circle learns this account's
 * routing id (a `push_enabled` entry, since senders read it from their
 * own roster).
 */


export type PushRegistration = {
  /** The platform's own token — FCM registration id, or an APNs token. */
  pushToken: string;
  platform: 'ios' | 'android';
  categories: PushCategory[];
};

/**
 * Writes this circle's control row: which categories to deliver, and the
 * hash that authorizes a sender.
 *
 * Separate from the device row because it needs no push token — the
 * preferences UI can work before notification permission is even asked
 * for. Re-run after a key rotation: the fanout token follows the current
 * content key, so a stale hash stops verifying and this circle quietly
 * goes dark. `resyncPushIfStale` is what notices.
 */
export async function syncCirclePushPrefs(circleId: string, categories: PushCategory[]): Promise<void> {
  const masterSeed = await getMasterSeed();
  const current = await getCurrentContentKey(circleId);
  if (!masterSeed || !current) return;

  const pushRoutingId = derivePushRoutingId(masterSeed, circleId);
  const pushFanoutHash = derivePushFanoutHash(derivePushFanoutToken(current.key), pushRoutingId);

  await putPushPrefs(pushRoutingId, pushFanoutHash, categories, current.version);
  await setCirclePushKeyVersion(circleId, current.version);
}

/** Turns notifications on for a circle. The only path that writes to the log. */
export async function registerPushForCircle(circleId: string, registration: PushRegistration): Promise<void> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) return;

  await syncCirclePushPrefs(circleId, registration.categories);

  const pushRoutingId = derivePushRoutingId(masterSeed, circleId);
  const deviceId = derivePushDeviceId(await getPushDeviceSecret(), pushRoutingId);
  await putPushDevice(pushRoutingId, deviceId, registration.pushToken, registration.platform, true);
  await publishPushRoutingId(circleId, pushRoutingId);
}

/**
 * Tells the circle where to reach this account. Queued through the outbox
 * like every other meta write, so an offline device still gets there.
 *
 * Skipped when the roster already agrees: this runs on every launch, and
 * a routing id only changes if the seed does.
 */
async function publishPushRoutingId(circleId: string, pushRoutingId: string): Promise<void> {
  const identity = await getCircleIdentity(circleId);
  const current = await getCurrentContentKey(circleId);
  if (!identity || !current) return;

  const ownPublicKey = bytesToHex(identity.publicKey);
  const members = await getCircleMembers(circleId);
  if (members.some((member) => member.identityPublicKey === ownPublicKey && member.pushRoutingId === pushRoutingId)) return;

  const entry = buildAndEncryptLogEntry(
    EntryTypes.PUSH_ENABLED,
    { pushRoutingId, createdAt: Date.now() },
    identity,
    current.key,
  );
  await insertOutboxEntry({
    circleId,
    entryType: EntryTypes.PUSH_ENABLED,
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    blobEntryId: null,
    encryptedMeta: entry,
  });
  await setMemberPushRoutingId(circleId, ownPublicKey, pushRoutingId);

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
}

/** Stops this one device receiving a circle's notifications. Others keep theirs. */
export async function unregisterDeviceForCircle(circleId: string): Promise<void> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) return;

  const pushRoutingId = derivePushRoutingId(masterSeed, circleId);
  await deletePushDevice(pushRoutingId, derivePushDeviceId(await getPushDeviceSecret(), pushRoutingId));
}

/**
 * Silences a circle for every device on this account.
 *
 * Enforced by unregistering rather than by filtering on arrival: iOS shows
 * a card for any delivered alert push, so the only way to show nothing is
 * for nothing to be delivered.
 */
export async function silenceCircle(circleId: string): Promise<void> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) return;

  await deletePushRouting(derivePushRoutingId(masterSeed, circleId));
}
