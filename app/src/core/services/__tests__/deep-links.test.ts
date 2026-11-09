import { withoutStagingPrefix } from '@/core/services/deep-links';

describe('withoutStagingPrefix', () => {
  test('a staging link resolves to the production path on the same host', () => {
    expect(withoutStagingPrefix('https://joinmimoza.com/staging/join/abc123')).toBe('https://joinmimoza.com/join/abc123');
  });

  test('a bare staging path loses its prefix too', () => {
    expect(withoutStagingPrefix('/staging/join/abc123')).toBe('/join/abc123');
  });

  test('production links and custom schemes pass through untouched', () => {
    expect(withoutStagingPrefix('https://joinmimoza.com/join/abc123')).toBe('https://joinmimoza.com/join/abc123');
    expect(withoutStagingPrefix('mimoza-staging://join/abc123')).toBe('mimoza-staging://join/abc123');
  });

  test('a path that only starts with the word staging is left alone', () => {
    expect(withoutStagingPrefix('/stagingfoo/join/abc')).toBe('/stagingfoo/join/abc');
  });
});
