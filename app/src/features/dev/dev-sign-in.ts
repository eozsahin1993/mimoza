import { saveAuthToken } from '@/core/services/keystore/auth-token';
import { getLocalAccount } from '@/data/db';
import { getProfile } from '@/features/account/services/account-relay';
import { signInAsDevAccount } from '@/features/account/services/auth-relay';
import type { SignInResult } from '@/features/account/usecases/sign-in';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';

/**
 * Dummy accounts for testing several devices against a local relay, one
 * per device. Off unless the build opts in, and never in a release build:
 * the relay route behind it only exists on a LocalStack relay.
 */
export const DEV_ACCOUNTS = [
  { subject: 'dev-alice', name: 'Alice' },
  { subject: 'dev-bob', name: 'Bob' },
  { subject: 'dev-carol', name: 'Carol' },
  { subject: 'dev-dave', name: 'Dave' },
] as const;

export type DevAccount = (typeof DEV_ACCOUNTS)[number];

export const devSignInEnabled = __DEV__ && process.env.EXPO_PUBLIC_DEV_SIGN_IN === 'true';

/**
 * Wipes this device's local data first when it belongs to another account:
 * finishSignIn trusts any local profile, so switching person on one device
 * (or a LocalStack reset handing Alice a new id) would carry on as the last
 * one. Keypairs are scoped per account and kept, so switching back to
 * someone skips key recovery.
 */
export async function signInWithDevAccount(account: DevAccount): Promise<SignInResult> {
  const { token, accountId } = await signInAsDevAccount(account.subject);
  const local = await getLocalAccount();
  if (local && local.accountId !== accountId) await resetLocalDataForTesting({ keepKeypair: true });
  await saveAuthToken(token);
  const { name } = await getProfile();
  return { outcome: 'success', suggestedName: account.name, relayProfile: { accountId, name } };
}
