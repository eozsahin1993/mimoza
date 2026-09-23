import { deleteAccount as deleteAccountOnRelay } from '@/features/account/services/account-relay';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';

/**
 * Deletes this account. One relay call — it erases every circle this
 * account is in, its own rows, and every session — so nothing here needs
 * to walk anything first, unlike the old per-circle departure that used
 * to make this a resumable, multi-step process.
 */
export async function deleteAccount(): Promise<void> {
  await deleteAccountOnRelay();
  await resetLocalDataForTesting();
}
