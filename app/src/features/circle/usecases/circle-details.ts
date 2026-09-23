import { getCircle, getMember, getProfile, listMembers, type Circle, type Member } from '@/data/db';
import { listInvites, type Invite } from '@/features/invite/services/invite-relay';

export type CircleDetails = {
  circle: Circle | null;
  members: Member[];
  ownIsAdmin: boolean;
  /** Null in the gap between joining and that join completing. */
  ownPublicKey: string | null;
  /** The circle's live code, for an admin to share. Null for a member, who cannot make one. */
  invite: Invite | null;
  /** Which notifications this circle sends — now a plain field on the row itself, not a separate synced preference. */
  notifyLevel: string;
};

/**
 * The details screen's whole read, mirroring `loadCircleFeedMeta` —
 * local database only, and data rather than view models — except the
 * invite, which the relay owns and nothing stores here.
 */
export async function loadCircleDetails(circleId: string): Promise<CircleDetails> {
  const [circle, members, profile] = await Promise.all([getCircle(circleId), listMembers(circleId), getProfile()]);
  const ownMember = profile ? await getMember(circleId, profile.accountId) : null;
  const admin = ownMember?.role === 'admin';

  // Admins only, and never fatal: the screen is worth showing without a
  // code, and the relay refuses the read to anyone else anyway.
  const invite = admin
    ? await listInvites(circleId)
        .then((invites) => invites[0] ?? null)
        .catch(() => null)
    : null;

  return {
    circle,
    members,
    ownIsAdmin: admin,
    ownPublicKey: profile?.accountId ?? null,
    invite,
    notifyLevel: circle?.notifyLevel ?? 'all',
  };
}
