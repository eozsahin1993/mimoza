import { generateUUID, hashBytes } from '@/core/crypto/primitives';
import { getProfile as getLocalProfile, saveProfile } from '@/data/db';
import { setName } from '@/features/account/services/account-relay';
import { syncOwnAvatarBestEffort } from '@/features/circle/usecases/set-member-avatar';

export type ProfileInput = {
  name: string;
  picture: Uint8Array | null;
};

/**
 * Saves the device profile and publishes the name to the relay — what
 * "finish setting up your profile" means. The relay owns the name, and a
 * circle's roster reads it from there directly, so there's nothing to
 * broadcast for that. The picture is different: each circle's roster
 * reads a member's own `avatarId` off its own membership row, sealed
 * under that circle's own key, so a changed picture does need pushing out
 * — see syncOwnAvatarBestEffort.
 *
 * Reused for editing an existing profile too (see profile-setup.tsx), so
 * the device id is kept across calls rather than reminted — a fresh one
 * on every edit would silently orphan this device's push registration
 * under the old id.
 */
export async function completeProfileSetup(profile: ProfileInput): Promise<void> {
  const relayProfile = await setName(profile.name);
  const existing = await getLocalProfile();
  const now = Date.now();
  await saveProfile({
    accountId: relayProfile.accountId,
    name: profile.name,
    picture: profile.picture,
    deviceId: existing?.deviceId || generateUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  // Guarded on an actual change, not just re-sent on every edit: this app
  // preloads the existing picture into the edit screen, so an unrelated
  // name-only edit would otherwise re-upload and re-encrypt it into every
  // circle under a brand new (but identical) avatarId each time.
  if (profile.picture && hashBytes(profile.picture) !== (existing?.picture ? hashBytes(existing.picture) : null)) {
    syncOwnAvatarBestEffort(relayProfile.accountId, profile.picture).catch((err) =>
      console.error('Failed to sync the new picture to circles', err)
    );
  }
}
