import { getProfile, markCircleLeft } from '@/data/db';
import { generateContentKey } from '@/features/circle/crypto';
import { getRoster, leaveCircle as leaveOnRelay } from '@/features/circle/services/circle-relay';
import { sealForEach } from '@/features/circle/usecases/key-exchange';

/**
 * Rotates on the way out, so nothing written afterwards is readable with
 * the copy this device keeps.
 *
 * The keys already held are deliberately kept: posts synced before
 * leaving stay readable offline, which is what `leftAt` means — left,
 * not erased. The relay refuses the last admin, who must promote someone
 * first.
 */
export async function leaveCircle(circleId: string): Promise<void> {
  const profile = await getProfile();
  if (!profile) throw new Error('No profile on this device.');

  const roster = await getRoster(circleId);
  const staying = roster.members.filter((member) => member.accountId !== profile.accountId);

  // Nothing to seal when the last member leaves; the relay takes the
  // circle with them.
  await leaveOnRelay(circleId, roster.keyVersion, sealForEach(staying, generateContentKey()));

  await markCircleLeft(circleId, Date.now());
}
