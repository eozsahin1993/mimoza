let mockExpoConfig: { extra?: { inviteLinkBase?: string } } = {};
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
  },
}));

import { inviteLink } from '@/features/invite/services/invite-link';

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
