import { eq } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { deviceProfile } from '@/data/db/schema';

export type Profile = typeof deviceProfile.$inferSelect;

/**
 * One row: this account and this device. The picture is the original,
 * kept so it can be sealed again for each circle — there is no
 * account-level avatar on the relay.
 */
export async function getProfile(): Promise<Profile | null> {
  const [row] = await db.select().from(deviceProfile).limit(1);
  if (!row) return null;
  return { ...row, picture: normalizeBlob(row.picture) };
}

export async function saveProfile(profile: typeof deviceProfile.$inferInsert): Promise<void> {
  await db
    .insert(deviceProfile)
    .values(profile)
    .onConflictDoUpdate({
      target: deviceProfile.accountId,
      set: { name: profile.name, picture: profile.picture, updatedAt: profile.updatedAt },
    });
}

export async function forgetProfile(accountId: string): Promise<void> {
  await db.delete(deviceProfile).where(eq(deviceProfile.accountId, accountId));
}
