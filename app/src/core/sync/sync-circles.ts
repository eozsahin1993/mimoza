import {
  AttachmentKinds,
  AttachmentStatuses,
  applyCircle,
  applyRoster,
  coverEntryId,
  getAttachment,
  getCircle,
  getProfile,
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
import { getCircleKeyMap } from '@/core/services/keystore/circle-keys';
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
  // Sign-in saves the auth token before profile setup writes this row, and
  // the scheduler's only gate is the token — so a pass can land in that
  // gap. Nothing below can run without knowing which account this device
  // is, so there is nothing to do yet.
  const profile = await getProfile();
  if (!profile) return 0;

  const { circles, requests } = await timed('sync.circles', () => listCircles());
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
      await syncCircle(circle, now, profile.accountId);
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
async function syncCircle(circle: Circle, now: number, myAccountId: string): Promise<void> {
  const before = await getCircle(circle.circleId);
  await applyCircle(circle, now);

  const rosterMoved =
    !before ||
    before.rosterVersion !== circle.rosterVersion ||
    before.keyVersion !== circle.keyVersion;
  if (rosterMoved) {
    try {
      const roster = await timed('sync.roster', () => getRoster(circle.circleId));
      await storeSealedKeys(circle.circleId, roster.keys, myAccountId);
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
      // who holds the keys seals them again. It is idempotent in nature.
      if (!circle.needsRewrap) {
        let resealFailed = false;
        for (const member of roster.members.filter((member) => member.needsRewrap)) {
          await resealFor(circle.circleId, member).catch((err) => {
            resealFailed = true;
            console.error(`Failed to reseal keys for ${member.accountId} in ${circle.circleId}`, err);
          });
        }

        if (resealFailed) throw new Error(`Could not reseal keys in circle ${circle.circleId}`);
      }
    } catch (err) {
      // Roll the two version fields back to whatever was last
      // confirmed (or 0, a circle this device has never synced) so the
      // next pass sees this as still-stale and tries again.
      await applyCircle({ ...circle, rosterVersion: before?.rosterVersion ?? 0, keyVersion: before?.keyVersion ?? 0 }, now);
      throw err;
    }
  }

  if (circle.coverId && circle.coverKeyVersion) {
    const entryId = coverEntryId(circle.coverId);
    if (!(await getAttachment(circle.circleId, entryId))) {
      const keys = await getCircleKeyMap(circle.circleId);
      if (keys?.[circle.coverKeyVersion]) {
        await insertAttachment({
          circleId: circle.circleId,
          entryId,
          kind: AttachmentKinds.CIRCLE_COVER,
          keyVersion: circle.coverKeyVersion,
          status: AttachmentStatuses.PENDING,
          fetchAttempts: 0,
          nextAttemptAt: null,
          createdAt: now,
        });
      }
    }
  }

  await timed('sync.push', () => drainOutbox(circle.circleId));

  const ctx = await entryContext(circle.circleId);
  if (!ctx) return;
  await timed('sync.posts', () => pullNewEntries(ctx, 'post'));
  await timed('sync.activity', () => pullNewEntries(ctx, 'activity'));
}
