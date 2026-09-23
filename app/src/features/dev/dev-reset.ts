import { getAllCircleIds, resetAllLocalData, resetDatabaseSchema } from '@/data/db';
import { clearOwnColorSeedCache } from '@/ui/theme/hooks/use-own-color-seed';
import { deleteCircleKeys } from '@/core/services/keystore/circle-keys';
import { forgetAccountKeypair } from '@/core/services/keystore/account-keypair';
import { deleteAuthToken } from '@/core/services/keystore/auth-token';

/**
 * Wipes every circle key in the Keychain, the account keypair, the auth
 * token, and all local circle/post/etc. data.
 *
 * Two callers, deliberately different safety levels. `finishAccountDeletionIfPending`
 * (`delete-account.ts`) calls this for real, as the last step of an
 * account deletion the user already confirmed through its own screen —
 * by then `getAllCircleIds` is already empty (each circle purged as its
 * departure drained), so this call's real job is the account keypair and
 * auth token. The `__DEV__` menu also calls it directly, with none of
 * that safety net, to let a fresh sign-in be exercised repeatedly without
 * reinstalling — deliberately kept out of sign-in.ts's signOut(), which
 * touches none of this.
 */
export async function resetLocalDataForTesting(): Promise<void> {
  const circleIds = await getAllCircleIds();
  for (const circleId of circleIds) {
    await deleteCircleKeys(circleId);
  }
  await forgetAccountKeypair();
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
