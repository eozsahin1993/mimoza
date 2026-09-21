import AsyncStorage from '@react-native-async-storage/async-storage';

import { getAppSettings } from '@/core/services/settings';
import { ALL_INVITE_PUSH, InvitePushCategories, PushCategories } from '@/features/push-notifications/usecases/push-categories';

/**
 * Pinned deliberately, not merely asserted. These are bit positions inside
 * masks already stored on devices and in the relay's prefs rows, so
 * renumbering one silently changes what every stored mask means — someone
 * who asked for comments starts getting reactions, and nothing errors.
 *
 * Adding a category means a new line here with the next free value. Editing
 * an existing line is what this exists to stop.
 */
test('category values are permanent', () => {
  expect(PushCategories).toEqual({
    newPost: 0,
    comment: 1,
    reaction: 2,
    memberJoined: 3,
  });
});

test('invite category values are permanent', () => {
  expect(InvitePushCategories).toEqual({
    joinRequest: 0,
    joinApproved: 1,
  });
});

/** settings.ts spells the default out to stay free of feature code; this keeps the two equal. */
test('a phone starts with every invite category on', async () => {
  await AsyncStorage.clear();

  expect((await getAppSettings()).invitePushMask).toBe(ALL_INVITE_PUSH);
});
