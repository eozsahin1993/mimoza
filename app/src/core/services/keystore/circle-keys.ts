import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { deleteSecret, getSecret, setSecret } from '@/core/services/keystore/store';

function keyMapStorageKey(circleId: string) {
  return `circle_keys_${circleId}`;
}

/** One circle's full `{version -> content key}` map — every version this member has ever held, since old content stays encrypted under whichever key was current when it was posted. */
export type ContentKeyMap = Record<number, Uint8Array>;

/** Persists this circle's full content-key map, replacing whatever was stored before. */
export async function saveCircleKeyMap(circleId: string, keyMap: ContentKeyMap): Promise<void> {
  const value = JSON.stringify(Object.fromEntries(Object.entries(keyMap).map(([version, key]) => [version, bytesToHex(key)])));
  await setSecret(keyMapStorageKey(circleId), value);
}

/** Reads this circle's full content-key map back, or null if none is stored. */
export async function getCircleKeyMap(circleId: string): Promise<ContentKeyMap | null> {
  const raw = await getSecret(keyMapStorageKey(circleId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Record<string, string>;
  return Object.fromEntries(Object.entries(parsed).map(([version, hex]) => [Number(version), hexToBytes(hex)]));
}

/**
 * The content key this device should encrypt new content with and derive
 * the current write token from — the highest version in the map. Null if
 * no map is stored, or the map is empty.
 */
export async function getCurrentContentKey(circleId: string): Promise<{ version: number; key: Uint8Array } | null> {
  const keyMap = await getCircleKeyMap(circleId);
  if (!keyMap) return null;
  const versions = Object.keys(keyMap).map(Number);
  if (versions.length === 0) return null;
  const version = Math.max(...versions);
  return { version, key: keyMap[version] };
}

/**
 * Merges one new content-key version into whatever's already stored —
 * used when a rotation lands, never overwrites older versions: a member
 * needs every version it's ever held to decrypt old content, not just the
 * current one.
 */
export async function addCircleKeyVersion(circleId: string, version: number, key: Uint8Array): Promise<void> {
  const existing = (await getCircleKeyMap(circleId)) ?? {};
  await saveCircleKeyMap(circleId, { ...existing, [version]: key });
}

/** Removes the content-key map for a circle (e.g. on leave). */
export async function deleteCircleKeys(circleId: string): Promise<void> {
  await deleteSecret(keyMapStorageKey(circleId));
}
