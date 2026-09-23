import {
  applyMembership,
  applyRoster,
  getCircle,
  dropRequest,
  listCircles as listLocalCircles,
  listRequests,
  markCircleLeft,
  upsertRequest,
} from '@/data/db';
import { nudgePhotoQueue } from '@/core/photo/photo-queue';
import { timed } from '@/core/utils/timing';
import { drainOutbox } from '@/core/sync/drain-outbox';
import { pullNewEntries } from '@/core/sync/pull-entries';
import { entryContext } from '@/core/sync/entry-handlers';
import { getRoster, listCircles, type Membership } from '@/features/circle/services/circle-relay';
import { resealFor, storeSealedKeys } from '@/features/circle/usecases/key-exchange';

/**
 * What a sync is now: ask the relay what this account is in, take the
 * roster and keys for anything that moved, push what is queued, then
 * walk each circle's entries forward.
 *
 * The relay owns membership, so there is no log to replay and nothing to
 * verify — a pass is a handful of reads whose results are written
 * straight down.
 */
export async function syncCircles(): Promise<number> {
  const { circles, requests } = await timed('sync.me', () => listCircles());
  const now = Date.now();

  // The invite code is this device's own and is not echoed back, so
  // these are upserted rather than replaced. One the relay has stopped
  // listing has been answered.
  const asked = new Set(requests.map((request) => request.circleId));
  for (const request of requests) {
    await upsertRequest({
      circleId: request.circleId,
      inviteCode: '',
      circleName: request.circleName ?? '',
      submittedAt: request.createdAt,
      status: request.status,
    });
  }
  for (const local of await listRequests()) {
    if (!asked.has(local.circleId)) await dropRequest(local.circleId);
  }

  // A circle the relay no longer lists is one this account left or was
  // removed from. The rows stay as a local archive rather than being
  // deleted, so what was already synced is still readable.
  const present = new Set(circles.map((circle) => circle.circleId));
  for (const local of await listLocalCircles()) {
    if (!present.has(local.id)) await markCircleLeft(local.id, now);
  }

  let failed = 0;
  for (const membership of circles) {
    try {
      await syncCircle(membership, now);
    } catch (err) {
      console.error(`Failed to sync circle ${membership.circleId}`, err);
      failed += 1;
    }
  }

  nudgePhotoQueue();
  return failed;
}

/**
 * One circle. The roster is refetched only when the relay says it moved,
 * which is the common case of nothing having changed costing nothing.
 *
 * Order matters in one place: keys land before entries are walked, since
 * a page encrypted under a version this device has not been given yet
 * would be skipped and never revisited — cursors do not rewind.
 */
async function syncCircle(membership: Membership, now: number): Promise<void> {
  const before = await getCircle(membership.circleId);
  await applyMembership(membership, now);

  const rosterMoved =
    !before ||
    before.rosterVersion !== membership.rosterVersion ||
    before.keyVersion !== membership.keyVersion;
  if (rosterMoved) {
    const roster = await timed('sync.roster', () => getRoster(membership.circleId));
    await storeSealedKeys(membership.circleId, roster.keys);
    await applyRoster(
      membership.circleId,
      roster.members.map((member) => ({
        circleId: membership.circleId,
        accountId: member.accountId,
        name: member.name ?? '',
        avatarId: member.avatarId ?? null,
        avatarKeyVersion: member.avatarKeyVersion ?? null,
        publicKey: member.publicKey ?? '',
        role: member.role,
        joinedAt: member.joinedAt,
        needsRewrap: member.needsRewrap ?? false,
      })),
      now
    );

    // Someone replaced their keypair and can read nothing until a member
    // who holds the keys seals them again. Whoever syncs first does it,
    // and a repeat is harmless. Never this account: its own flag is
    // cleared by somebody else, and it has nothing to seal from.
    if (!membership.needsRewrap) {
      for (const member of roster.members.filter((member) => member.needsRewrap)) {
        await resealFor(membership.circleId, member).catch((err) =>
          console.error(`Failed to reseal keys for ${member.accountId} in ${membership.circleId}`, err)
        );
      }
    }
  }

  await timed('sync.push', () => drainOutbox(membership.circleId));

  const ctx = await entryContext(membership.circleId);
  if (!ctx) return;
  await timed('sync.posts', () => pullNewEntries(ctx, 'post'));
  await timed('sync.activity', () => pullNewEntries(ctx, 'activity'));
}
