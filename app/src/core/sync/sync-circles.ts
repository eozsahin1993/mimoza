import {
  AttachmentKinds,
  AttachmentStatuses,
  applyCircle,
  applyRoster,
  coverEntryId,
  getCircle,
  dropRequest,
  insertAttachment,
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
import { getRoster, listCircles, type Circle } from '@/features/circle/services/circle-relay';
import { resealFor, storeSealedKeys } from '@/features/circle/usecases/key-exchange';

/**
 * What a sync is now: ask the relay what this account is in, take the
 * roster and keys for anything that moved, push what is queued, then
 * walk each circle's entries forward.
 *
 * The relay owns circle, so there is no log to replay and nothing to
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
  for (const circle of circles) {
    try {
      await syncCircle(circle, now);
    } catch (err) {
      console.error(`Failed to sync circle ${circle.circleId}`, err);
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
async function syncCircle(circle: Circle, now: number): Promise<void> {
  const before = await getCircle(circle.circleId);
  await applyCircle(circle, now);

  // Unconditional, not folded into rosterMoved below: a cover change
  // bumps neither rosterVersion nor keyVersion, so gating this on that
  // flag would miss it. Requires coverKeyVersion, not just coverId — a
  // circle whose cover was set before the relay carried a version would
  // otherwise get a row that retries forever and never succeeds (see
  // fetchOne in photo-queue.ts, which needs a real key version to fetch
  // at all). onConflictDoNothing makes a repeat of the same cover free.
  if (circle.coverId && circle.coverKeyVersion) {
    await insertAttachment({
      circleId: circle.circleId,
      entryId: coverEntryId(circle.coverId),
      kind: AttachmentKinds.CIRCLE_COVER,
      keyVersion: circle.coverKeyVersion,
      status: AttachmentStatuses.PENDING,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt: now,
    });
  }

  const rosterMoved =
    !before ||
    before.rosterVersion !== circle.rosterVersion ||
    before.keyVersion !== circle.keyVersion;
  if (rosterMoved) {
    const roster = await timed('sync.roster', () => getRoster(circle.circleId));
    await storeSealedKeys(circle.circleId, roster.keys);
    await applyRoster(
      circle.circleId,
      roster.members.map((member) => ({
        circleId: circle.circleId,
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
    if (!circle.needsRewrap) {
      for (const member of roster.members.filter((member) => member.needsRewrap)) {
        await resealFor(circle.circleId, member).catch((err) =>
          console.error(`Failed to reseal keys for ${member.accountId} in ${circle.circleId}`, err)
        );
      }
    }
  }

  await timed('sync.push', () => drainOutbox(circle.circleId));

  const ctx = await entryContext(circle.circleId);
  if (!ctx) return;
  await timed('sync.posts', () => pullNewEntries(ctx, 'post'));
  await timed('sync.activity', () => pullNewEntries(ctx, 'activity'));
}
