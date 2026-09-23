import { applyRoster, getProfile } from '@/data/db';
import { addCircleKeyVersion } from '@/core/services/keystore/circle-keys';
import { generateContentKey } from '@/features/circle/crypto';
import { getRoster, removeMember as removeOnRelay } from '@/features/circle/services/circle-relay';
import { sealForEach } from '@/features/circle/usecases/key-exchange';

/**
 * Removes a member and rotates the content key past them.
 *
 * The roster is read fresh, not taken from local state: the relay
 * refuses a set of seals that is not exactly the survivors, so a stale
 * roster leaves someone unable to read anything new. `expectedVersion`
 * makes two admins removing at once safe — the loser refetches.
 */
export async function removeMember(circleId: string, accountId: string): Promise<void> {
  const profile = await getProfile();
  if (!profile) throw new Error('No profile on this device.');

  const roster = await getRoster(circleId);
  const survivors = roster.members.filter((member) => member.accountId !== accountId);
  const nextKey = generateContentKey();

  await removeOnRelay(circleId, accountId, roster.keyVersion, sealForEach(survivors, nextKey));

  // Everything written from here is under this key, and the removed
  // member has no copy.
  await addCircleKeyVersion(circleId, roster.keyVersion + 1, nextKey);
  await applyRoster(
    circleId,
    survivors.map((member) => ({
      circleId,
      accountId: member.accountId,
      name: member.name ?? '',
      avatarId: member.avatarId ?? null,
      avatarKeyVersion: member.avatarKeyVersion ?? null,
      publicKey: member.publicKey ?? '',
      role: member.role,
      joinedAt: member.joinedAt,
      needsRewrap: member.needsRewrap ?? false,
    })),
    Date.now()
  );
}
