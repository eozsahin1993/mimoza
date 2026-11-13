let mockExpoConfig: { extra?: { inviteLinkBase?: string } } = {};
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
  },
}));

import { inviteCodeFromLink, inviteLink } from '@/features/invite/services/invite-link';

describe('inviteLink', () => {
  test('uses the https base the build was configured with', () => {
    mockExpoConfig = { extra: { inviteLinkBase: 'https://joinmimoza.com/join/' } };

    expect(inviteLink('abc123')).toBe('https://joinmimoza.com/join/abc123');
  });

  test('falls back to the custom scheme in a build without one', () => {
    mockExpoConfig = {};

    expect(inviteLink('abc123')).toBe('mimoza://join/abc123');
  });
});

describe('inviteCodeFromLink', () => {
  test.each([
    'https://joinmimoza.com/join/abcd2345wxyz',
    'https://joinmimoza.com/staging/join/abcd2345wxyz',
    'mimoza://join/abcd2345wxyz',
    'mimoza-staging://join/abcd2345wxyz',
    '  https://joinmimoza.com/join/abcd2345wxyz/\n',
  ])('reads the code out of %j', (link) => {
    expect(inviteCodeFromLink(link)).toBe('abcd2345wxyz');
  });

  test('reads back whatever inviteLink produced', () => {
    mockExpoConfig = { extra: { inviteLinkBase: 'https://joinmimoza.com/staging/join/' } };

    expect(inviteCodeFromLink(inviteLink('abcd2345wxyz'))).toBe('abcd2345wxyz');
  });

  test.each([
    'abcd2345wxyz',
    'https://example.com/join/abcd2345wxyz',
    'https://joinmimoza.com/join/',
    'https://joinmimoza.com/join/abcd/extra',
    'mimoza://link/abcd2345wxyz',
    '{"kind":"device-link"}',
  ])('is null for %j', (text) => {
    expect(inviteCodeFromLink(text)).toBeNull();
  });
});
