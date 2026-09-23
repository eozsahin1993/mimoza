import SyncedKeystore from '../../../../modules/synced-keystore';

/**
 * The account keypair's storage: synced through each platform's own
 * trusted backup — iCloud Keychain on iOS, Google Block Store on
 * Android — rather than store.ts's local-only Keychain/Keystore.
 *
 * Nothing else should use this. An auth token or a re-derivable
 * content-key cache has no business following the user to a new device
 * outside the app's own relay-driven sync — see store.ts for those.
 */

/**
 * iCloud Keychain delivery to a freshly restored device is asynchronous
 * and can trail app launch by seconds — a miss right after restore can
 * mean "not delivered yet" rather than "never existed". These retries
 * narrow that window; they cannot close it. A caller that mints a
 * replacement key on a still-empty result is acting on a possibility,
 * not a certainty — see the warning on ensureAccountKeypair.
 */
const RESTORE_RETRY_DELAYS_MS = [500, 1000, 2000];

export async function getSyncedSecret(key: string): Promise<string | null> {
  for (const delay of RESTORE_RETRY_DELAYS_MS) {
    const value = await SyncedKeystore.getSynced(key);
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return SyncedKeystore.getSynced(key);
}

export function setSyncedSecret(key: string, value: string): Promise<void> {
  return SyncedKeystore.setSynced(key, value);
}

export function deleteSyncedSecret(key: string): Promise<void> {
  return SyncedKeystore.deleteSynced(key);
}
