jest.mock('@/features/account/services/account-relay');
jest.mock('@/core/services/keystore/synced-store');

import { generateEphemeralKeypair } from '@/core/crypto/primitives';
import { toWire } from '@/core/crypto/content';
import { forgetAccountKeypair, saveAccountKeypair } from '@/core/services/keystore/account-keypair';
import { getProfile, publishPublicKey } from '@/features/account/services/account-relay';
import {
  KeypairPublishError,
  KeypairStatuses,
  checkAccountKeypairStatus,
  publishAccountKeypair,
  publishAccountKeypairOrDegrade,
} from '@/features/account/usecases/account-keypair-flow';

const ACCOUNT_ID = 'acc-1';
const RELAY_PROFILE = { accountId: ACCOUNT_ID, name: 'Ali', createdAt: 0 };
const KEYPAIR = generateEphemeralKeypair();

beforeEach(() => {
  jest.clearAllMocks();
  (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE });
  (publishPublicKey as jest.Mock).mockResolvedValue({ awaitingRewrap: [] });
});

afterEach(async () => {
  await forgetAccountKeypair(ACCOUNT_ID);
});

describe('checkAccountKeypairStatus', () => {
  test('a local keypair matching the relay is in sync', async () => {
    await saveAccountKeypair(ACCOUNT_ID, KEYPAIR);
    (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE, publicKey: toWire(KEYPAIR.publicKey) });

    expect(await checkAccountKeypairStatus(ACCOUNT_ID)).toEqual({ kind: KeypairStatuses.IN_SYNC });
  });

  // Having a local keypair is not the same as being in sync: an earlier
  // sign-in can mint one and decline to publish it (ambiguousRestore),
  // leaving a perfectly usable local key the relay has never heard of.
  // Nothing to ask the user here — it just needs publishing.
  test('a local keypair differing from the relay is a mismatch, not recovery', async () => {
    await saveAccountKeypair(ACCOUNT_ID, KEYPAIR);
    (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE, publicKey: 'something-else' });

    expect(await checkAccountKeypairStatus(ACCOUNT_ID)).toEqual({
      kind: KeypairStatuses.KEYPAIR_MISMATCH,
      keypair: KEYPAIR,
    });
  });

  test('no local keypair and no name on the relay is a fresh signup', async () => {
    (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE, name: '' });

    expect(await checkAccountKeypairStatus(ACCOUNT_ID)).toEqual({ kind: KeypairStatuses.FRESH_SIGNUP });
  });

  test('no local keypair but a name on the relay needs recovery', async () => {
    expect(await checkAccountKeypairStatus(ACCOUNT_ID)).toEqual({ kind: KeypairStatuses.NEEDS_RECOVERY });
  });
});

describe('publishAccountKeypair', () => {
  test('a freshly minted keypair is published as a reset', async () => {
    await publishAccountKeypair(ACCOUNT_ID, KEYPAIR, true);

    const [publishedKey, reset] = (publishPublicKey as jest.Mock).mock.calls[0];
    expect(publishedKey).toBe(toWire(KEYPAIR.publicKey));
    expect(reset).toBe(true);
  });

  // A restore reading empty before iCloud/Block Store delivers the real
  // key is indistinguishable, locally, from a genuinely lost key — the
  // relay already having a publicKey is the signal there's a real key to
  // wait for. Publishing as a reset would force every circle through a
  // rewrap for a key about to show up on its own.
  test('a fresh mint when the relay already has a key on file is not published', async () => {
    (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE, publicKey: 'existing-key-on-relay' });

    await publishAccountKeypair(ACCOUNT_ID, KEYPAIR, true);

    expect(publishPublicKey).not.toHaveBeenCalled();
  });

  test('a keypair already matching the relay publishes nothing', async () => {
    (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE, publicKey: toWire(KEYPAIR.publicKey) });

    await publishAccountKeypair(ACCOUNT_ID, KEYPAIR, false);

    expect(publishPublicKey).not.toHaveBeenCalled();
  });

  // The case an earlier version got wrong: created is false (the device
  // already had this key), but it still differs from what's on file, so
  // circles sealed to the old one need a reseal same as a mint would.
  test('an existing keypair differing from the relay is published as a reset', async () => {
    (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE, publicKey: 'something-else' });

    await publishAccountKeypair(ACCOUNT_ID, KEYPAIR, false);

    const [, reset] = (publishPublicKey as jest.Mock).mock.calls[0];
    expect(reset).toBe(true);
  });

  test('a publish failure is wrapped, not left as the raw cause', async () => {
    (publishPublicKey as jest.Mock).mockRejectedValue(new Error('relay down'));

    await expect(publishAccountKeypair(ACCOUNT_ID, KEYPAIR, true)).rejects.toThrow(KeypairPublishError);
  });
});

describe('publishAccountKeypairOrDegrade', () => {
  test('swallows a publish failure so an already-successful sign-in survives it', async () => {
    (publishPublicKey as jest.Mock).mockRejectedValue(new Error('relay down'));

    await expect(publishAccountKeypairOrDegrade(ACCOUNT_ID, KEYPAIR, true)).resolves.toBeUndefined();
  });

  test('still throws anything that is not a KeypairPublishError', async () => {
    (getProfile as jest.Mock).mockRejectedValue(new Error('network error'));

    await expect(publishAccountKeypairOrDegrade(ACCOUNT_ID, KEYPAIR, true)).rejects.toThrow('network error');
  });
});
