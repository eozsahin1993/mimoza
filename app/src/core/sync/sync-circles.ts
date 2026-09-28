import {
  AttachmentKinds,
  AttachmentStatuses,
  applyCircle,
  applyRoster,
  avatarEntryId,
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
import { getRoster, listCircles, type Circle, type RosterMember } from '@/features/circle/services/circle-relay';
import { resealFor, storeSealedKeys } from '@/features/circle/usecases/key-exchange';
import { setMemberAvatar } from '@/features/circle/usecases/set-member-avatar';
import { ensureCircleNotificationChannel, removeCircleNotificationChannel } from '@/features/push-notifications/services/channels';

export type SyncOptions = {
  /**
   * Pull-to-refresh's escape hatch: walk roster and entries regardless
   * of what the relay's version hints say moved.
   */
  force?: boolean;
  /** Restricts the pass to just this circle — every other one is skipped entirely, not merely left unforced. */
  circleId?: string;
};

/**
 * What a sync is now: ask the relay what this account is in, take the
 * roster and keys for anything that moved, push what is queued, then
 * walk each circle's entries forward.
 *
 * The relay owns circle, so there is no log to replay and nothing to
 * verify — a pass is a handful of reads whose results are written
 * straight down.
 */
export async function syncCircles(options: SyncOptions = {}): Promise<number> {
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
    if (!present.has(local.id)) {
      await markCircleLeft(local.id, now);
      await removeCircleNotificationChannel(local.id).catch((err) =>
        console.error(`Failed to remove notification channel for ${local.id}`, err)
      );
    }
  }

  let failed = 0;
  for (const circle of circles) {
    if (options.circleId && options.circleId !== circle.circleId) continue;
    try {
      await withCircleLock(circle.circleId, () =>
        syncCircle(circle, now, profile.accountId, profile.picture, options.force ?? false)
      );
    } catch (err) {
      console.error(`Failed to sync circle ${circle.circleId}`, err);
      failed += 1;
    }
  }

  nudgePhotoQueue();
  return failed;
}

/**
 * Only runSync's own callers get its inFlight dedup — the scheduler, the
 * circles list's pull-to-refresh, and a feed's own sync-and-reload all
 * call syncCircles directly. Two of those landing on the same circle at
 * once would otherwise run two real walks over its cursors with nothing
 * to stop them clobbering each other's writes. This serializes by circle
 * id instead of coalescing like runSync's does, so a caller's own
 * force/circleId scope is never silently dropped by joining an unrelated
 * pass — it just waits its turn.
 */
const circleLocks = new Map<string, Promise<void>>();

async function withCircleLock(circleId: string, fn: () => Promise<void>): Promise<void> {
  const queued = (circleLocks.get(circleId) ?? Promise.resolve()).catch(() => undefined).then(fn);
  circleLocks.set(circleId, queued);
  try {
    await queued;
  } finally {
    if (circleLocks.get(circleId) === queued) circleLocks.delete(circleId);
  }
}

/**
 * One circle. The roster is refetched only when the relay says it moved,
 * which is the common case of nothing having changed costing nothing.
 *
 * Order matters in one place: keys land before entries are walked, since
 * a page encrypted under a version this device has not been given yet
 * would be skipped and never revisited — cursors do not rewind.
 */
async function syncCircle(
  circle: Circle,
  now: number,
  myAccountId: string,
  myPicture: Uint8Array | null,
  force: boolean
): Promise<void> {
  const before = await getCircle(circle.circleId);
  await applyCircle(circle, now);

  // A circle this device has never stored, is rejoining after having left
  // (which deleted its Android channel — see removeCircleNotificationChannel
  // above), or was just renamed needs its channel (re)created. Done here,
  // before the roster walk below can throw: applyCircle above already wrote
  // the current name regardless of what happens next, so a check placed
  // after a failed roster fetch would see before.name already matching on
  // every later pass and skip this permanently.
  if (!before || before.leftAt !== null || before.name !== circle.name) {
    await ensureCircleNotificationChannel(circle.circleId, circle.name).catch((err) =>
      console.error(`Failed to ensure notification channel for ${circle.circleId}`, err)
    );
  }

  const rosterMoved =
    force ||
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

      await queueMissingMemberAvatarFetches(circle.circleId, roster.members, now);

      // A circle this device has never seen before — a fresh join, or its
      // first pull of one created elsewhere — starts with no avatarId for
      // this account unless another of this account's devices already set
      // one first. Seed it the same way an edit does, rather than leaving
      // it on initials until the next profile edit happens to touch it.
      if (!before && myPicture) {
        await seedOwnAvatarIfMissing(circle.circleId, myAccountId, myPicture, roster.members);
      }

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
    await queueAttachmentFetchIfMissing(circle.circleId, coverEntryId(circle.coverId), AttachmentKinds.CIRCLE_COVER, circle.coverKeyVersion, now);
  }

  await timed('sync.push', () => drainOutbox(circle.circleId));

  // lastEntryAt rides on every post, comment, reaction, roster and meta
  // write (see the relay's TouchCircle) — unchanged means nothing here
  // needs a page walked, so this is what skips the two calls below.
  const entriesMoved = force || !before || before.lastEntryAt !== (circle.lastEntryAt ?? 0);
  if (!entriesMoved) return;

  const ctx = await entryContext(circle.circleId);
  if (!ctx) return;
  await timed('sync.posts', () => pullNewEntries(ctx, 'post'));
  await timed('sync.activity', () => pullNewEntries(ctx, 'activity'));
}

/**
 * A no-op unless this device doesn't already know about this
 * content-addressed attachment — a cover, or a member's avatar — and a
 * key for the version it's sealed under has actually arrived. A cover and
 * an avatar differ only in kind/entryId/keyVersion, never in what "needs
 * fetching" means, so both funnel through here.
 *
 * Never network work itself: the only effect, when it does have one, is a
 * local PENDING row. nudgePhotoQueue (called once at the end of
 * syncCircles) is the thing that actually downloads it, on its own, later.
 */
async function queueAttachmentFetchIfMissing(circleId: string, entryId: string, kind: string, keyVersion: number, now: number): Promise<void> {
  if (await getAttachment(circleId, entryId)) return;

  const circleKeys = await getCircleKeyMap(circleId);
  if (!circleKeys?.[keyVersion]) return;

  await insertAttachment({
    circleId,
    entryId,
    kind,
    keyVersion,
    status: AttachmentStatuses.PENDING,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt: now,
  });
}

/** Every member's avatarId that this device doesn't already know about, queued at once. */
async function queueMissingMemberAvatarFetches(circleId: string, members: RosterMember[], now: number): Promise<void> {
  for (const member of members) {
    if (!member.avatarId || member.avatarKeyVersion == null) continue;
    await queueAttachmentFetchIfMissing(circleId, avatarEntryId(member.accountId, member.avatarId), AttachmentKinds.MEMBER_AVATAR, member.avatarKeyVersion, now);
  }
}

/**
 * A circle this device has never seen before — a fresh join, or its first
 * pull of one created elsewhere — starts with no avatarId for this
 * account unless another of this account's own devices already set one.
 * Seed it the same way an edit does, rather than leaving it on initials
 * until a later profile edit happens to touch it.
 */
async function seedOwnAvatarIfMissing(
  circleId: string,
  myAccountId: string,
  myPicture: Uint8Array,
  members: RosterMember[]
): Promise<void> {
  const own = members.find((member) => member.accountId === myAccountId);
  if (own?.avatarId) return;

  await setMemberAvatar(circleId, myAccountId, myPicture).catch((err) =>
    console.error(`Failed to seed the avatar in circle ${circleId}`, err)
  );
}
