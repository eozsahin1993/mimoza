import { getLocalAccount, markCircleLeft } from '@/data/db';
import { generateContentKey } from '@/features/circle/crypto';
import { getRoster, leaveCircle as leaveOnRelay } from '@/features/circle/services/circle-relay';
import { MemberRoles, setMemberRole } from '@/features/circle/usecases/change-member-role';
import { sealForEach } from '@/features/circle/usecases/key-exchange';
import { removeCircleNotificationChannel } from '@/features/push-notifications/services/channels';

type Standing = { accountId: string; role: string; joinedAt: number };

/**
 * Who inherits the circle when its only admin leaves: the
 * longest-standing of everyone else, the same pick the relay makes when
 * an account is deleted. Null when nobody has to. The leave dialog asks
 * this too, so the handover is named before it happens.
 */
export function departingSuccessor<T extends Standing>(members: T[], ownAccountId: string): T | null {
  const own = members.find((member) => member.accountId === ownAccountId);
  if (own?.role !== MemberRoles.ADMIN) return null;

  const others = members.filter((member) => member.accountId !== ownAccountId);
  if (others.some((member) => member.role === MemberRoles.ADMIN)) return null;

  return others.reduce<T | null>(
    (oldest, member) => (!oldest || member.joinedAt < oldest.joinedAt ? member : oldest),
    null
  );
}

/**
 * Rotates on the way out, so nothing written afterwards is readable with
 * the copy this device keeps.
 *
 * The keys already held are deliberately kept: posts synced before
 * leaving stay readable offline, which is what `leftAt` means — left,
 * not erased. The relay refuses the last admin, so an only admin
 * promotes their successor first. Not atomic with the leave, and it
 * doesn't need to be: if the leave then fails the circle just has an
 * extra admin, and a retry finds one and leaves.
 */
export async function leaveCircle(circleId: string): Promise<void> {
  const profile = await getLocalAccount();
  if (!profile) throw new Error('No profile on this device.');

  const roster = await getRoster(circleId);
  const staying = roster.members.filter((member) => member.accountId !== profile.accountId);

  const successor = departingSuccessor(roster.members, profile.accountId);
  if (successor) await setMemberRole(circleId, successor.accountId, MemberRoles.ADMIN);

  // Nothing to seal when the last member leaves; the relay takes the
  // circle with them.
  await leaveOnRelay(circleId, roster.keyVersion, sealForEach(staying, generateContentKey()));

  await markCircleLeft(circleId, Date.now());
  await removeCircleNotificationChannel(circleId).catch((err) =>
    console.error(`Failed to remove notification channel for ${circleId}`, err)
  );
}
