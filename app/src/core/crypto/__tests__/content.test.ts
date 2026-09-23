import { openContent, sealContent } from '@/core/crypto/content';

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(8);

describe('circle content', () => {
  test('a round trip gives back what went in', () => {
    const sealed = sealContent({ caption: 'at the lake', createdAt: 42 }, KEY);

    expect(openContent(sealed, KEY)).toEqual({ caption: 'at the lake', createdAt: 42 });
  });

  test('it crosses the wire as base64', () => {
    expect(sealContent({ a: 1 }, KEY)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  // Every unusable case returns null rather than throwing, so one bad
  // entry can never abort a sync pass.
  test('the wrong key gives null', () => {
    expect(openContent(sealContent({ a: 1 }, KEY), OTHER_KEY)).toBeNull();
  });

  test('tampered ciphertext gives null', () => {
    const sealed = sealContent({ a: 1 }, KEY);
    const tampered = `A${sealed.slice(1)}`;

    expect(openContent(tampered, KEY)).toBeNull();
  });

  test('something that is not base64 at all gives null', () => {
    expect(openContent('not base64 ~~~', KEY)).toBeNull();
  });
});
