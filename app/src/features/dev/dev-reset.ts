import { getAllCircleIds, getProfile, resetAllLocalData, resetDatabaseSchema } from '@/data/db';
import { clearOwnColorSeedCache } from '@/ui/theme/hooks/use-own-color-seed';
import { deleteCircleKeys } from '@/core/services/keystore/circle-keys';
import { deleteCirclePhotoFiles } from '@/core/photo/photo-cache';
import { forgetAccountKeypair } from '@/core/services/keystore/account-keypair';
import { deleteAuthToken } from '@/core/services/keystore/auth-token';

/**
 * Wipes every circle key in the Keychain, the account keypair, the auth
 * token, the decrypted photo cache, and all local circle/post/etc. data.
 *
 * Two callers, deliberately different safety levels.
 * `finishAccountDeletionIfPending` (`delete-account.ts`) calls this for
 * real, as the last step of an account deletion the user already
 * confirmed through its own screen — `getAllCircleIds` is still the full
 * list at that point, since nothing purges a circle locally before this
 * runs. The `__DEV__` menu also calls it directly, with none of that
 * safety net, to let a fresh sign-in be exercised repeatedly without
 * reinstalling — deliberately kept out of sign-in.ts's signOut(), which
 * touches none of this.
 */
export async function resetLocalDataForTesting(): Promise<void> {
  // Read before resetAllLocalData below removes the row the account id
  // comes from — the keypair is scoped per account, so forgetting it
  // needs to happen first, or not at all if this device never got as
  // far as profile setup. Also tolerates the read itself failing: this
  // is the __DEV__ menu's escape hatch for a local schema stuck behind a
  // migration-index collision (see AGENTS.md), where device_profile can
  // genuinely not exist yet — the one action meant to recover from that
  // must not be what a broken schema blocks.
  const profile = await getProfile().catch(() => null);
  const circleIds = await getAllCircleIds();
  for (const circleId of circleIds) {
    await deleteCircleKeys(circleId);
    deleteCirclePhotoFiles(circleId);
  }
  if (profile) await forgetAccountKeypair(profile.accountId);
  await deleteAuthToken();
  await resetAllLocalData();
  // The next sign-in's own avatar colour would otherwise keep showing this
  // account's, cached in memory since ordinary sign-out never clears it.
  clearOwnColorSeedCache();
}

/**
 * `resetLocalDataForTesting` plus the schema itself, for the __DEV__ menu
 * action — the tests call the cheaper one, which keeps the tables.
 */
export async function resetEverythingForTesting(): Promise<void> {
  await resetLocalDataForTesting();
  await resetDatabaseSchema();
}
