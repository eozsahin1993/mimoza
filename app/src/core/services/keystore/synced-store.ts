import { deleteSecret, getSecret, setSecret } from '@/core/services/keystore/store';
import SyncedKeystore from '../../../../modules/synced-keystore';

/**
 * The account keypair's storage: synced through each platform's own
 * trusted backup — iCloud Keychain on iOS, Google Block Store on
 * Android — paired with a plain local write (store.ts's SecureStore) so
 * this device's own copy never depends on either platform's sync layer
 * actually working. Android's Block Store in particular can resolve a
 * write successfully while silently storing nothing at all, if the
 * device has no lock screen set (see AGENTS.md) — nothing here can tell
 * that apart from a real write by its return value alone, so the local
 * copy is the one thing this module actually trusts.
 *
 * Nothing else should use this. An auth token or a re-derivable
 * content-key cache has no business following the user to a new device
 * outside the app's own relay-driven sync — see store.ts for those.
 */

/** Covers iOS's async iCloud delivery lag; a harmless no-op wait on Android, whose Block Store has no equivalent. */
const RESTORE_RETRY_DELAYS_MS = [500, 1000, 2000];

async function getSyncedOnce(key: string): Promise<string | null> {
  try {
    return await SyncedKeystore.getSynced(key);
  } catch (err) {
    console.error(`[synced-store] get ${key}: sync read failed`, err);
    return null;
  }
}

/**
 * Local first, always: this device's own copy — written by an earlier
 * setSyncedSecret call, on this install or a previous one — answers
 * before either platform's sync layer is even asked. Only a device that
 * genuinely has nothing local falls through to recovering one from
 * iCloud Keychain/Block Store, exactly the "new device" case that layer
 * exists for.
 */
export async function getSyncedSecret(key: string): Promise<string | null> {
  const local = await getSecret(key);
  if (local !== null) {
    console.log(`[synced-store] get ${key}: found locally`);
    return local;
  }

  for (const delay of RESTORE_RETRY_DELAYS_MS) {
    const value = await getSyncedOnce(key);
    if (value !== null) {
      console.log(`[synced-store] get ${key}: found via sync`);
      await setSecret(key, value);
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const value = await getSyncedOnce(key);
  console.log(`[synced-store] get ${key}: ${value !== null ? 'found via sync' : 'not found'} after retries`);
  if (value !== null) await setSecret(key, value);
  return value;
}

/**
 * Local write first and unconditional — this is what get() above
 * actually relies on. The synced write is strictly best-effort on top of
 * it: whether or not it lands, this device already holds its own
 * readable copy either way, so its failure is logged and swallowed
 * rather than surfaced as this call failing.
 */
export async function setSyncedSecret(key: string, value: string): Promise<void> {
  await setSecret(key, value);
  console.log(`[synced-store] set ${key}: written locally`);
  try {
    await SyncedKeystore.setSynced(key, value);
    console.log(`[synced-store] set ${key}: written via sync`);
  } catch (err) {
    console.error(`[synced-store] set ${key}: sync write failed (local copy still holds it)`, err);
  }
}

export async function deleteSyncedSecret(key: string): Promise<void> {
  await deleteSecret(key);
  try {
    await SyncedKeystore.deleteSynced(key);
    console.log(`[synced-store] delete ${key}: done`);
  } catch (err) {
    console.error(`[synced-store] delete ${key}: sync delete failed (local copy still removed)`, err);
  }
}
