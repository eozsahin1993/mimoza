import { bytesToHex, concatBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The whole vocabulary — there is no free-form slot. A fixed set keeps
 * counts meaningful (a hundred near-identical faces would each stand
 * alone) and keeps the feed's tone bounded, which an open emoji keyboard
 * cannot. Order is deliberate: warmth first, then celebration, then the
 * quieter ones.
 *
 * It lives here rather than beside the picker because this is what
 * hashes it: a tag is over the exact bytes, so `❤️` (U+2764 U+FE0F) and
 * a bare U+2764 are different reactions, and a second copy anywhere
 * would drift into tagging things nothing can name. Every device hashes
 * this one constant and never a typed string, which is what makes two
 * devices agree without any coordination.
 *
 * Adding an emoji is safe, and nothing rejects one from outside this set
 * arriving over the wire — a newer build may have added it, and dropping
 * those would lose real reactions. Removing or respelling one is not
 * safe: reactions made with it stop being nameable.
 */
export const REACTION_EMOJI = ['❤️', '🥂', '😂', '😭', '👏', '🙏', '✨', '🧿'];

const TAG_DOMAIN = new TextEncoder().encode('reaction-tag');

/**
 * The key every one of a circle's reaction tags is made with. Derived
 * from the circle's *first* content key and bound to the circle id, so
 * it is secret from the relay, different in every circle, and — unlike
 * the content key itself — the same forever.
 *
 * Not rotating is deliberate. A tag that changed with the content key
 * would split one emoji's count across versions and leave a device that
 * is mid-rewrap unable to name its own reactions, and it would buy
 * almost nothing: a removed member loses relay access entirely, so there
 * are no new counts for them to read either way. The circle id alone
 * cannot stand in for this — the relay knows it, and would be able to
 * build the whole table.
 *
 * Null when this device has no version 1, which should not happen: a
 * joiner is sealed every version 1..current, and a reseal carries every
 * version the resealer holds.
 */
export function reactionTagKey(circleId: string, keys: Record<number, Uint8Array>): Uint8Array | null {
  const root = keys[1];
  if (!root) return null;
  return hkdf(sha256, root, undefined, concatBytes(TAG_DOMAIN, new TextEncoder().encode(circleId)), 32);
}

export function reactionTag(emoji: string, tagKey: Uint8Array): string {
  return bytesToHex(hmac(sha256, tagKey, new TextEncoder().encode(emoji)));
}

/** Tag to emoji, for reading the relay's count map. Eight entries; built once per sync pass. */
export function reactionTagTable(tagKey: Uint8Array | null): Record<string, string> {
  if (!tagKey) return {};
  const table: Record<string, string> = {};
  for (const emoji of REACTION_EMOJI) table[reactionTag(emoji, tagKey)] = emoji;
  return table;
}
