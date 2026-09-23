import type { Activity } from '@/data/db';
import { formatDay } from '@/core/utils/time';
import type { LanguageCode } from '@/core/i18n/languages';

/**
 * The subset of the relay's activity events this feed groups into roster
 * blocks. `renamed`/`cover_changed` are circle-level, not about a member,
 * and carry the new name/cover id in `subjectName` rather than a person —
 * they have no row here yet, the same as before the relay could send them
 * at all.
 */
const MEMBERSHIP_EVENTS = new Set(['created', 'joined', 'left', 'removed', 'account_deleted', 'promoted', 'demoted']);

export function isMembershipEvent(event: Activity): boolean {
  return MEMBERSHIP_EVENTS.has(event.event);
}

/** membership-event-row.tsx's own vocabulary — "left" folds into "removed" plus selfInflicted, same as before the relay named it separately. */
export type MemberEventKind = 'created' | 'added' | 'removed' | 'role_changed' | 'account_deleted';
export type MemberRole = 'admin' | 'member';

/** One activity row, translated into what the row components already render. */
export type MemberEvent = {
  id: string;
  kind: MemberEventKind;
  role: MemberRole | null;
  selfInflicted: boolean;
  actorPublicKey: string;
  /** Null when this device doesn't currently know the actor's name — see resolveActorName. */
  actorName: string | null;
  subjectPublicKey: string;
  subjectName: string;
  occurredAt: number;
};

function memberEventKind(event: string): MemberEventKind | null {
  switch (event) {
    case 'created':
      return 'created';
    case 'joined':
      return 'added';
    case 'left':
    case 'removed':
      return 'removed';
    case 'account_deleted':
      return 'account_deleted';
    case 'promoted':
    case 'demoted':
      return 'role_changed';
    default:
      return null;
  }
}

/** Resolves the actor's current name — live roster only; unlike subjectName, an activity row carries none of its own to fall back to. */
export type ResolveActorName = (accountId: string) => string | null;

export function toMemberEvents(events: Activity[], resolveActorName: ResolveActorName): MemberEvent[] {
  const out: MemberEvent[] = [];
  for (const event of events) {
    const kind = memberEventKind(event.event);
    if (!kind) continue;

    out.push({
      id: event.id,
      kind,
      role: event.event === 'promoted' ? 'admin' : event.event === 'demoted' ? 'member' : null,
      selfInflicted: event.actorId === event.subjectId,
      actorPublicKey: event.actorId,
      actorName: resolveActorName(event.actorId),
      subjectPublicKey: event.subjectId ?? '',
      // A created row's subjectName is the circle's name, not the
      // founder's (circle/store.go writes SubjectName: circle.Name) —
      // resolve the founder's own name live instead, same as the actor.
      subjectName: (event.event === 'created' ? resolveActorName(event.subjectId ?? '') : event.subjectName) ?? '',
      occurredAt: event.receivedAt,
    });
  }
  return out;
}

/**
 * One subject swept into a group — just enough to name them, in the order
 * they were acted on (oldest first, so "and N others" always hides the
 * most recent rather than the first).
 */
export type GroupedSubject = { subjectPublicKey: string; subjectName: string };

/**
 * Every event sharing one day, one actor (or "nobody in particular", for a
 * self-inflicted kind — see `groupKey`), and one action, folded into a
 * single row's worth of subjects.
 */
export type MembershipEventGroup = {
  kind: MemberEventKind;
  role: MemberRole | null;
  selfInflicted: boolean;
  actorPublicKey: string;
  actorName: string | null;
  subjects: GroupedSubject[];
  /** The group's most recent event — decides where its row sorts against posts and other groups. */
  occurredAt: number;
};

/** A day's worth of grouped events — broken up wherever a post intervenes, even within the same day. */
export type MembershipEventBlock = {
  /** `formatDay`'s label for every event in this block — not necessarily unique across blocks, see `groupMemberEvents`. */
  day: string;
  groups: MembershipEventGroup[];
  /** The block's most recent event — decides where its day header sorts. */
  occurredAt: number;
};

/**
 * Turns a flat, newest-first list of roster changes into day blocks of
 * consolidated groups — what the feed actually renders instead of one row
 * per event.
 *
 * A block ends, and a new one starts, wherever the next event either
 * lands on a different calendar day or has a post between it and the
 * previous event — a post breaks up a day's events into two blocks rather
 * than being merged with either. Two blocks can carry the same `day`
 * label this way; that's deliberate, not a bug, since a post is real news
 * that shouldn't read as continuous with what came before it.
 *
 * Both `events` and `postTimestamps` must already be sorted newest-first —
 * this never re-sorts either, so a caller with a different order gets
 * nonsense blocks silently rather than a clear failure.
 */
export function groupMemberEvents(
  events: MemberEvent[],
  postTimestamps: number[],
  language: LanguageCode,
): MembershipEventBlock[] {
  // A single forward pointer into `postTimestamps`, walked alongside
  // `events` — O(events + posts) instead of rescanning every post per event.
  let postIndex = 0;

  const blocks: MembershipEventBlock[] = [];
  let current: MemberEvent[] = [];

  const flush = () => {
    if (current.length > 0) blocks.push(buildBlock(current, language));
    current = [];
  };

  for (const event of events) {
    const previous = current[current.length - 1];
    if (previous !== undefined) {
      // Posts at or after `previous` were already ruled out (by this
      // check or an earlier one) and can never matter again — every
      // event from here on is older still.
      while (postIndex < postTimestamps.length && postTimestamps[postIndex] >= previous.occurredAt) postIndex++;
      const postBetween = postIndex < postTimestamps.length && postTimestamps[postIndex] > event.occurredAt;
      if (formatDay(event.occurredAt, language) !== formatDay(previous.occurredAt, language) || postBetween) flush();
    }
    current.push(event);
  }
  flush();

  return blocks;
}

function buildBlock(events: MemberEvent[], language: LanguageCode): MembershipEventBlock {
  const groups = new Map<string, MembershipEventGroup>();
  const order: string[] = [];

  // Newest-first, same as `events` — so the first event seen for a given
  // key is that group's most recent, and `order` ends up newest-group-first.
  for (const event of events) {
    const key = groupKey(event);
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: event.kind,
        role: event.role,
        selfInflicted: event.selfInflicted,
        actorPublicKey: event.actorPublicKey,
        actorName: event.actorName,
        subjects: [],
        occurredAt: event.occurredAt,
      };
      groups.set(key, group);
      order.push(key);
    }
    // Pushed newest-first here too; reversed below once every event in
    // this block has been seen.
    group.subjects.push({ subjectPublicKey: event.subjectPublicKey, subjectName: event.subjectName });
  }
  for (const key of order) groups.get(key)!.subjects.reverse();

  return { day: formatDay(events[0].occurredAt, language), groups: order.map((key) => groups.get(key)!), occurredAt: events[0].occurredAt };
}

/**
 * What makes two events "the same action" — actor, kind, and role
 * (`role_changed` only, so a promotion never merges with a demotion).
 * `kind` already carries the "left" vs "deleted their account" split —
 * `account_deleted` is its own value here, not `removed` plus a side
 * flag — so this needs no special case for it.
 */
function groupKey(event: MemberEvent): string {
  const actor = event.selfInflicted ? 'self' : event.actorPublicKey;
  return `${actor}\0${event.kind}\0${event.role ?? ''}`;
}
