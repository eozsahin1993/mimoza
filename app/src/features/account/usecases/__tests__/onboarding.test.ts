jest.mock('@/features/account/services/account-relay');
jest.mock('@/features/account/usecases/set-profile-picture');

import { deleteProfilePicture, getLocalAccount, initDatabase, storeProfilePicture } from '@/data/db';
import { forgetLocalAccount } from '@/data/db/local-account';
import { completeProfileSetup } from '@/features/account/usecases/onboarding';
import { setName } from '@/features/account/services/account-relay';
import { publishProfilePicture, removeProfilePicture } from '@/features/account/usecases/set-profile-picture';

const ACCOUNT_ID = 'acc-1';

/**
 * completeProfileSetup fires the picture publish/remove without awaiting
 * it (see onboarding.ts) — a test that needs the mock's own write to
 * profilePictures to have landed before its next assertion or call
 * flushes the microtask queue first, rather than racing it.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeAll(() => initDatabase());

beforeEach(async () => {
  jest.clearAllMocks();
  // One row per accountId, so a fresh test must not inherit the previous
  // test's row — completeProfileSetup's "keep the device id" behavior,
  // and its hash-based no-op-edit guard, would otherwise pass for the
  // wrong reason.
  await forgetLocalAccount(ACCOUNT_ID);
  await deleteProfilePicture(ACCOUNT_ID);
  (setName as jest.Mock).mockResolvedValue({ accountId: ACCOUNT_ID, name: 'Ali', createdAt: 0 });
  // Mirrors what the real functions actually do to profilePictures — the
  // hash guard in onboarding.ts reads that table back as its baseline, so
  // a mock that didn't really write to it would make every call look like
  // a fresh change.
  (publishProfilePicture as jest.Mock).mockImplementation(async (accountId: string, photo: Uint8Array) => {
    await storeProfilePicture(accountId, 'pic-1', photo);
    return 'pic-1';
  });
  (removeProfilePicture as jest.Mock).mockImplementation(async (accountId: string) => {
    await deleteProfilePicture(accountId);
  });
});

describe('completeProfileSetup', () => {
  test('saves the local profile and publishes the name to the relay', async () => {
    const picture = new Uint8Array([1, 2, 3]);

    await completeProfileSetup({ name: 'Ali', picture });

    expect(setName).toHaveBeenCalledWith('Ali');
    const profile = await getLocalAccount();
    expect(profile?.accountId).toBe(ACCOUNT_ID);
    expect(profile?.name).toBe('Ali');
    // The picture itself goes through publishProfilePicture (mocked here,
    // asserted in its own test below) — the local profile row has nothing
    // picture-shaped left on it to check.
  });

  test('mints a device id the first time', async () => {
    await completeProfileSetup({ name: 'Ali', picture: null });

    expect((await getLocalAccount())?.deviceId).toBeTruthy();
  });

  // A fresh id on every edit would silently orphan this device's push
  // registration under the old one.
  test('editing a profile keeps the same device id', async () => {
    await completeProfileSetup({ name: 'Ali', picture: null });
    const deviceId = (await getLocalAccount())?.deviceId;

    (setName as jest.Mock).mockResolvedValue({ accountId: ACCOUNT_ID, name: 'Ali Osman', createdAt: 0 });
    await completeProfileSetup({ name: 'Ali Osman', picture: null });

    expect((await getLocalAccount())?.deviceId).toBe(deviceId);
    expect((await getLocalAccount())?.name).toBe('Ali Osman');
  });

  test('editing a profile keeps the original createdAt', async () => {
    await completeProfileSetup({ name: 'Ali', picture: null });
    const createdAt = (await getLocalAccount())?.createdAt;

    await completeProfileSetup({ name: 'Ali Osman', picture: null });

    expect((await getLocalAccount())?.createdAt).toBe(createdAt);
  });

  // The relay owns the picture directly off the account now, with no
  // per-circle equivalent to reach — a first picture (or a changed one)
  // still has to be pushed out, just through this one call instead of one
  // per circle.
  test('publishes a first picture', async () => {
    const picture = new Uint8Array([1, 2, 3]);

    await completeProfileSetup({ name: 'Ali', picture });

    expect(publishProfilePicture).toHaveBeenCalledWith(ACCOUNT_ID, picture);
  });

  test('does not republish the picture on a name-only edit', async () => {
    const picture = new Uint8Array([1, 2, 3]);
    await completeProfileSetup({ name: 'Ali', picture });
    await flush();
    jest.clearAllMocks();

    await completeProfileSetup({ name: 'Ali Osman', picture });

    expect(publishProfilePicture).not.toHaveBeenCalled();
    expect(removeProfilePicture).not.toHaveBeenCalled();
  });

  test('republishes when the picture actually changes', async () => {
    await completeProfileSetup({ name: 'Ali', picture: new Uint8Array([1, 2, 3]) });
    await flush();
    jest.clearAllMocks();

    const nextPicture = new Uint8Array([4, 5, 6]);
    await completeProfileSetup({ name: 'Ali', picture: nextPicture });

    expect(publishProfilePicture).toHaveBeenCalledWith(ACCOUNT_ID, nextPicture);
  });

  // Going from a picture to none is its own change, distinct from a
  // no-op edit — it has to tell the relay to clear it, not just skip
  // publishing silently.
  test('removes the picture once it is cleared', async () => {
    await completeProfileSetup({ name: 'Ali', picture: new Uint8Array([1, 2, 3]) });
    await flush();
    jest.clearAllMocks();

    await completeProfileSetup({ name: 'Ali', picture: null });

    expect(removeProfilePicture).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(publishProfilePicture).not.toHaveBeenCalled();
  });

  test('never having had a picture is not a removal', async () => {
    await completeProfileSetup({ name: 'Ali', picture: null });
    await flush();
    jest.clearAllMocks();

    await completeProfileSetup({ name: 'Ali Osman', picture: null });

    expect(removeProfilePicture).not.toHaveBeenCalled();
    expect(publishProfilePicture).not.toHaveBeenCalled();
  });
});
