import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { derivePushDeviceId, derivePushOwnerToken } from '@/core/crypto/push';
import { getPushDeviceSecret } from '@/core/services/keystore/push-device-secret';
import { deletePushDevice, deletePushRouting, putPushDevice, putPushPrefs, type PushKind } from '@/core/services/push-relay';

/**
 * The writes every kind of push routing makes — circle, invite, pending
 * request (docs/PUSH_DESIGN.md, "Kinds of routing"). Each proves ownership with the owner
 * token, which only this account's seed produces. What differs by kind is
 * only which routing id, and what locks it.
 */

async function ownerTokenFor(pushRoutingId: string): Promise<Uint8Array> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');
  return derivePushOwnerToken(masterSeed, pushRoutingId);
}

/** A routing's control row: its kind, the categories it takes, and the hash of the token that may send to it. */
export async function putRoutingPrefs(
  pushRoutingId: string,
  kind: PushKind,
  fanoutHash: Uint8Array,
  /** Bits of the mask the relay stores; what each means is push-categories.ts's. */
  categories: number[],
  keyVersion: number,
): Promise<void> {
  await putPushPrefs(pushRoutingId, fanoutHash, categories, keyVersion, await ownerTokenFor(pushRoutingId), kind);
}

/** This device's row under a routing. Needs the prefs row there first. */
export async function putRoutingDevice(pushRoutingId: string, device: { pushToken: string; platform: 'ios' | 'android' }): Promise<void> {
  const deviceId = derivePushDeviceId(await getPushDeviceSecret(), pushRoutingId);
  await putPushDevice(pushRoutingId, deviceId, device.pushToken, device.platform, true, await ownerTokenFor(pushRoutingId));
}

/** Removes this device's row only; the account's other devices keep theirs. */
export async function deleteRoutingDevice(pushRoutingId: string): Promise<void> {
  const deviceId = derivePushDeviceId(await getPushDeviceSecret(), pushRoutingId);
  await deletePushDevice(pushRoutingId, deviceId, await ownerTokenFor(pushRoutingId));
}

/** The whole routing, prefs and every device, for every device on the account. */
export async function deleteRouting(pushRoutingId: string): Promise<void> {
  await deletePushRouting(pushRoutingId, await ownerTokenFor(pushRoutingId));
}
