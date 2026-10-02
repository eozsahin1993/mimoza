import { generateUUID, hashBytes } from '@/core/crypto/primitives';
import { getLocalAccount, getProfilePicture, saveLocalAccount } from '@/data/db';
import { setName } from '@/features/account/services/account-relay';
import { publishProfilePicture, removeProfilePicture } from '@/features/account/usecases/set-profile-picture';

export type ProfileInput = {
  name: string;
  picture: Uint8Array | null;
};

/**
 * Saves the local account and publishes the name to the relay — what
 * "finish setting up your profile" means. The relay owns both the name
 * and the picture directly off the account now, and a circle's roster
 * reads each from there, so neither needs pushing out circle by circle —
 * see publishProfilePicture.
 *
 * Reused for editing an existing profile too (see profile-setup.tsx), so
 * the device id is kept across calls rather than reminted — a fresh one
 * on every edit would silently orphan this device's push registration
 * under the old id.
 */
export async function completeProfileSetup(profile: ProfileInput): Promise<void> {
  const relayProfile = await setName(profile.name);
  const existing = await getLocalAccount();
  const existingPicture = await getProfilePicture(relayProfile.accountId);
  const now = Date.now();
  await saveLocalAccount({
    accountId: relayProfile.accountId,
    name: profile.name,
    deviceId: existing?.deviceId || generateUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  // Guarded on an actual change, not just re-sent on every edit: this app
  // preloads the existing picture into the edit screen, so an unrelated
  // name-only edit would otherwise re-upload the same bytes under a brand
  // new (but identical) pictureId each time.
  const existingHash = existingPicture?.bytes ? hashBytes(existingPicture.bytes) : null;
  if (profile.picture && hashBytes(profile.picture) !== existingHash) {
    publishProfilePicture(relayProfile.accountId, profile.picture).catch((err) =>
      console.error('Failed to publish the new profile picture', err)
    );
  } else if (!profile.picture && existingHash) {
    removeProfilePicture(relayProfile.accountId).catch((err) =>
      console.error('Failed to remove the profile picture', err)
    );
  }
}
