import { setMemberRole as setRoleLocally } from '@/data/db';
import { patchMembership } from '@/features/circle/services/circle-relay';

export const MemberRoles = { ADMIN: 'admin', MEMBER: 'member' } as const;
export type MemberRole = (typeof MemberRoles)[keyof typeof MemberRoles];

/**
 * Promotes or demotes someone. No keys move: the member already holds
 * every version, so a role is a bit on the relay and nothing else.
 *
 * The relay refuses demoting the last admin, which is the case worth
 * getting wrong — a circle with members and no admin can never be
 * administered again.
 */
export async function setMemberRole(circleId: string, accountId: string, role: MemberRole): Promise<void> {
  await patchMembership(circleId, accountId, { role });
  await setRoleLocally(circleId, accountId, role);
}
