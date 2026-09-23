import { generateUUID } from '@/core/crypto/primitives';
import { getProfile as getLocalProfile, saveProfile } from '@/data/db';
import { setName } from '@/features/account/services/account-relay';

export type ProfileInput = {
  name: string;
  picture: Uint8Array | null;
};

/**
 * Saves the device profile and publishes the name to the relay — what
 * "finish setting up your profile" means. The relay owns the name; a
 * circle's roster reads it from there directly, so there's nothing to
 * broadcast to circles the way there used to be.
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
}
