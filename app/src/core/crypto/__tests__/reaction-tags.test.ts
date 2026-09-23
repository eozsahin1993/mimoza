import { REACTION_EMOJI, reactionTag, reactionTagKey, reactionTagTable } from '@/core/crypto/reaction-tags';

const KEY_V1 = new Uint8Array(32).fill(1);
const KEY_V2 = new Uint8Array(32).fill(2);
const OTHER_V1 = new Uint8Array(32).fill(9);

const tagKey = (circleId: string, keys: Record<number, Uint8Array>) => reactionTagKey(circleId, keys)!;

describe('reaction tags', () => {
  test('the same emoji in the same circle is always the same tag', () => {
    const key = tagKey('family', { 1: KEY_V1 });

    expect(reactionTag('❤️', key)).toBe(reactionTag('❤️', key));
    expect(reactionTag('❤️', key)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different emoji give different tags', () => {
    const key = tagKey('family', { 1: KEY_V1 });

    expect(reactionTag('❤️', key)).not.toBe(reactionTag('😂', key));
  });

  // Every device derives from the same first content key, so two members
  // agree on a tag without ever exchanging one.
  test('two devices holding the same keys derive the same tag', () => {
    const mine = tagKey('family', { 1: KEY_V1 });
    const theirs = tagKey('family', { 1: KEY_V1, 2: KEY_V2 });

    expect(reactionTag('❤️', mine)).toBe(reactionTag('❤️', theirs));
  });

  // Bound to the circle id, so the relay cannot carry a guess about one
  // circle's tags into another.
  test('the same emoji tags differently in a different circle', () => {
    expect(reactionTag('❤️', tagKey('family', { 1: KEY_V1 }))).not.toBe(
      reactionTag('❤️', tagKey('friends', { 1: KEY_V1 }))
    );
  });

  test('the same emoji tags differently in a circle with a different key', () => {
    expect(reactionTag('❤️', tagKey('family', { 1: KEY_V1 }))).not.toBe(
      reactionTag('❤️', tagKey('family', { 1: OTHER_V1 }))
    );
  });

  // A rotation must not split one emoji's count in two.
  test('a rotation leaves the tag alone', () => {
    expect(reactionTag('❤️', tagKey('family', { 1: KEY_V1 }))).toBe(
      reactionTag('❤️', tagKey('family', { 1: KEY_V1, 2: KEY_V2 }))
    );
  });

  test('the table names every palette emoji, and only those', () => {
    const table = reactionTagTable(tagKey('family', { 1: KEY_V1 }));

    expect(Object.keys(table)).toHaveLength(REACTION_EMOJI.length);
    expect(table[reactionTag('🥂', tagKey('family', { 1: KEY_V1 }))]).toBe('🥂');
  });

  // Never happens in practice — a joiner is sealed every version from 1 —
  // but a missing version 1 has to be a nameable state rather than a crash.
  test('without version 1 there is no tag key and no table', () => {
    expect(reactionTagKey('family', { 2: KEY_V2 })).toBeNull();
    expect(reactionTagTable(null)).toEqual({});
  });
});
