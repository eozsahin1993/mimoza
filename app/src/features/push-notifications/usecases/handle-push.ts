import { bytesToHex } from '@noble/curves/utils.js';

import { getAllCircles, getCircle, getCircleMembers, getInviteByPushRoutingId, getPendingJoinRequestByPushRoutingId } from '@/data/db';
import { EntryTypes } from '@/core/sync/log-entry';
import { verifyLogEntry, type LogEntryEnvelope } from '@/core/sync/log-entry';
import { derivePushRoutingId } from '@/core/crypto/identity';
import { getCircleIdentity, getCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { circleNotificationChannelId, INVITES_CHANNEL_ID } from '@/features/push-notifications/services/channels';
import { readJoinRequestPush } from '@/features/invite/usecases/invite-push';
import { i18n } from '@/core/i18n/i18n';

/**
 * Turning a delivered push into the words on the lock screen.
 *
 * The relay forwards the entry's own ciphertext and cannot read it, so the
 * text is composed here, on the device, from keys the relay never has.
 */

export type PushNotification = { circleId: string; channelId: string; title: string; body: string };

/**
 * keyVersion is a string in FCM data messages, a number in APNs userInfo.
 * `kind` is the routing's own, named by the relay from the recipient's row.
 */
export type PushData = { pushRoutingId?: string; kind?: string; keyVersion?: string | number; payload?: string };

/** The most of a requester's self-reported name a lock screen shows: the sender chose it. */
const MAX_REQUESTER_NAME = 40;

/**
 * Decrypts a push and writes its notification, or null if it cannot —
 * a forged push from someone without the circle's key, a circle this
 * device has since left, or an entry type it doesn't render.
 *
 * Null means "show nothing new". Android can honour that; iOS shows the
 * placeholder that travelled in the payload, since a delivered alert push
 * always produces a card.
 */
export async function handlePush(data: PushData): Promise<PushNotification | null> {
  if (!data.pushRoutingId) return null;

  // The join handshake's two pushes aren't circle entries (invite-push.ts).
  if (data.kind === 'invite') return describeJoinRequest(data.pushRoutingId, data.payload);
  if (data.kind === 'pending_request') return describeJoinApproval(data.pushRoutingId);

  const circle = await circleForRoutingId(data.pushRoutingId);
  if (!circle) return null;

  const envelope = await decryptPushEntry(circle.id, data);
  if (!envelope) return null;

  const body = await describeEntry(circle.id, envelope);
  if (!body) return null;
  return { circleId: circle.id, channelId: circleNotificationChannelId(circle.id), title: circle.name, body };
}

/**
 * Matched by deriving, never by storing: a routing id is
 * `HKDF(seed, circleId)`, so this device can recompute its own and compare
 * without the relay ever having told it which circle is which.
 */
export async function circleForRoutingId(pushRoutingId: string) {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) return null;

  return (
    (await getAllCircles()).find((circle) => derivePushRoutingId(masterSeed, circle.id) === pushRoutingId) ?? null
  );
}

/** The decrypted, verified envelope a push carries — shared by the notification text (above) and tap routing (push-destination.ts). */
export async function decryptPushEntry(circleId: string, data: PushData): Promise<LogEntryEnvelope | null> {
  if (!data.payload) return null;

  const keyMap = await getCircleKeyMap(circleId);
  if (!keyMap) return null;

  // The push names its version, so this is one decrypt rather than one per
  // version held. A version this device doesn't have means an entry it was
  // never meant to read.
  const key = keyMap[Number(data.keyVersion)];
  if (!key) return null;

  return verifyLogEntry(new Uint8Array(Buffer.from(data.payload, 'base64')), key);
}

/**
 * Null for an entry type that shouldn't interrupt anyone. Each variant is a
 * whole sentence rather than pieces joined here, since word order differs
 * by language — and each has a twin in the iOS extension's string catalog.
 */
async function describeEntry(circleId: string, envelope: LogEntryEnvelope): Promise<string | null> {
  // `member_added` is signed by the admin who approved it, not by the
  // person joining, so the author is the wrong name here. It carries the
  // joiner's own — which is also the only name available, since this
  // arrives before the sync that would put them on the roster.
  if (envelope.type === EntryTypes.MEMBER_ADDED) {
    const joined = (envelope.payload as { name?: unknown })?.name;
    return i18n.t('push.joined', { name: typeof joined === 'string' && joined ? joined : i18n.t('push.someone') });
  }

  const name = await authorName(circleId, envelope.authorPubkey);
  switch (envelope.type) {
    case EntryTypes.POST:
      return i18n.t('push.post', { name });
    case EntryTypes.COMMENT: {
      const record = envelope.payload as { body?: unknown; postAuthorPubkey?: unknown } | undefined;
      const text = typeof record?.body === 'string' && record.body ? record.body : null;
      const postAuthor = record?.postAuthorPubkey;
      if (typeof postAuthor !== 'string') {
        return text ? i18n.t('push.commentWithText', { name, text }) : i18n.t('push.comment', { name });
      }

      const own = (await getCircleIdentity(circleId))?.publicKey;
      if (own && bytesToHex(own) === postAuthor) {
        return text ? i18n.t('push.commentOnYoursWithText', { name, text }) : i18n.t('push.commentOnYours', { name });
      }
      return text ? i18n.t('push.alsoCommentedWithText', { name, text }) : i18n.t('push.alsoCommented', { name });
    }
    case EntryTypes.REACTION: {
      // Every reaction push is already scoped to the post's own author (see
      // notify-circle.ts), so "your photo" is always literally true here.
      const emoji = (envelope.payload as { emoji?: unknown })?.emoji;
      return typeof emoji === 'string' && emoji
        ? i18n.t('push.reactionWithEmoji', { name, emoji })
        : i18n.t('push.reaction', { name });
    }
    default:
      return null;
  }
}

async function authorName(circleId: string, authorPubkey: string): Promise<string> {
  const member = (await getCircleMembers(circleId)).find(
    (candidate) => candidate.identityPublicKey === authorPubkey,
  );
  return member?.name || i18n.t('push.someone');
}

/** "Priya wants to join", under the circle's name. Someone, if the payload doesn't open. */
async function describeJoinRequest(pushRoutingId: string, payload?: string): Promise<PushNotification | null> {
  const invite = await getInviteByPushRoutingId(pushRoutingId);
  if (!invite) return null;

  const circle = await getCircle(invite.circleId);
  const name = payload ? readJoinRequestPush(new Uint8Array(Buffer.from(payload, 'base64')), invite.code) : null;
  const shown = name?.trim().slice(0, MAX_REQUESTER_NAME) || i18n.t('push.someone');
  return {
    circleId: invite.circleId,
    channelId: INVITES_CHANNEL_ID,
    title: circle?.name ?? '',
    body: i18n.t('push.joinRequest', { name: shown }),
  };
}

/**
 * The requester's side: sent only when the request is approved. Written
 * from their own pending row, not the push, and it says there's news
 * rather than "you're in": anyone else holding the code could send the
 * same push, so it can't be trusted to mean approval. Opening the app
 * checks.
 */
async function describeJoinApproval(pushRoutingId: string): Promise<PushNotification | null> {
  const pending = await getPendingJoinRequestByPushRoutingId(pushRoutingId);
  if (!pending) return null;

  return {
    circleId: pending.circleId,
    channelId: INVITES_CHANNEL_ID,
    title: pending.circleName,
    body: i18n.t('push.joinRequestNews'),
  };
}
