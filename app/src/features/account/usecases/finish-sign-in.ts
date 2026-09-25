import { router } from 'expo-router';

import { generateUUID } from '@/core/crypto/primitives';
import { getProfile, saveProfile } from '@/data/db';
import { enablePushEverywhere } from '@/features/push-notifications/usecases/enable-push';
import { goPostAuth } from '@/features/invite/services/pending-invite';

export type FinishSignIn = {
  accountId: string;
  /** The relay's name for this account, empty when it has never completed setup. */
  name: string;
  suggestedName?: string;
  suggestedPictureUrl?: string;
};

/**
 * Everything after a sign-in has resolved its keypair: register for push,
 * then land somewhere. Shared because two screens reach this point — the
 * welcome screen when nothing needed asking, and the device-link screen
 * once the person has chosen how to get their key back.
 *
 * Reads the local profile itself rather than taking it from the caller,
 * since the two callers can't share component state.
 */
export async function finishSignIn({ accountId, name, suggestedName, suggestedPictureUrl }: FinishSignIn): Promise<void> {
  // Launch skipped this while signed out, and signing out removed it.
  enablePushEverywhere().catch((error) => console.error('Failed to register for notifications', error));

  // A returning device (local profile already exists — e.g. this was just
  // a re-auth after signing out) has nothing new to fill in.
  if (await getProfile()) {
    await goPostAuth(router);
    return;
  }

  // No local profile, but the relay may already have a name for this
  // account — signing in on a new device for an account that completed
  // setup elsewhere.
  if (name) {
    const now = Date.now();
    await saveProfile({
      accountId,
      name,
      picture: null,
      deviceId: generateUUID(),
      createdAt: now,
      updatedAt: now,
    });
    await goPostAuth(router);
    return;
  }

  // Brand new account. Always through the form, pre-filled with whatever
  // the provider gave us.
  router.push({
    pathname: '/profile-setup',
    params: {
      suggestedName: suggestedName ?? '',
      suggestedPictureUrl: suggestedPictureUrl ?? '',
      onboarding: '1',
    },
  });
}
