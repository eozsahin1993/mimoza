jest.mock('@/features/account/services/account-relay');
jest.mock('@/core/services/keystore/synced-store');

import { generateEphemeralKeypair } from '@/core/crypto/primitives';
import { toWire } from '@/core/crypto/content';
import { DeviceLinkGoneError } from '@/core/services/relay-errors';
import { forgetAccountKeypair, getAccountKeypair, saveAccountKeypair } from '@/core/services/keystore/account-keypair';
import {
  sendDeviceLinkKeys,
  getProfile,
  createDeviceLink,
  readDeviceLink,
} from '@/features/account/services/account-relay';
import {
  collectDeviceLink,
  completeDeviceLink,
  parseDeviceLinkPayload,
  startDeviceLink,
} from '@/features/account/usecases/device-link';

const OLD_DEVICE = 'acc-old';
const NEW_DEVICE = 'acc-new';
const ACCOUNT_KEYPAIR = generateEphemeralKeypair();

beforeEach(() => {
  jest.clearAllMocks();
  (createDeviceLink as jest.Mock).mockResolvedValue({ sessionId: 'session-1', expiresAt: Date.now() + 300_000 });
  (sendDeviceLinkKeys as jest.Mock).mockResolvedValue(undefined);
  (getProfile as jest.Mock).mockResolvedValue({
    accountId: NEW_DEVICE,
    name: 'Ali',
    createdAt: 0,
    publicKey: toWire(ACCOUNT_KEYPAIR.publicKey),
  });
});

afterEach(async () => {
  await forgetAccountKeypair(OLD_DEVICE);
  await forgetAccountKeypair(NEW_DEVICE);
});

describe('startDeviceLink', () => {
  test('opens a session against a freshly minted key and encodes both in the payload', async () => {
    const started = await startDeviceLink();

    expect(createDeviceLink).toHaveBeenCalledWith(toWire(started.keypair.publicKey));
    expect(parseDeviceLinkPayload(started.payload)).toEqual({
      version: 1,
      sessionId: 'session-1',
      publicKey: toWire(started.keypair.publicKey),
    });
  });

  // The throwaway key is worth nothing once the handshake is over, and an
  // abandoned session should leave nothing behind on the device.
  test('keeps the throwaway keypair out of the keystore', async () => {
    const started = await startDeviceLink();

    expect(await getAccountKeypair(NEW_DEVICE)).toBeNull();
    expect(started.keypair.secretKey).toHaveLength(32);
  });
});

describe('parseDeviceLinkPayload', () => {
  // A camera reads whatever is in frame, so this is the first thing that
  // has to be sure — none of these should reach the relay.
  test.each([
    ['not JSON at all', 'https://example.com'],
    ['JSON that is not ours', '{"hello":"world"}'],
    ['a version we do not know', '{"version":2,"sessionId":"session-1","publicKey":"aaaa"}'],
    ['a missing session', '{"version":1,"sessionId":"","publicKey":"aaaa"}'],
    ['the old single-letter shape', '{"v":1,"s":"session-1","k":"aaaa"}'],
  ])('refuses %s', (_label, data) => {
    expect(() => parseDeviceLinkPayload(data)).toThrow();
  });

  test('refuses a key that cannot be an X25519 key', () => {
    const payload = JSON.stringify({ version: 1, sessionId: 'session-1', publicKey: toWire(new Uint8Array(8)) });

    expect(() => parseDeviceLinkPayload(payload)).toThrow(/damaged/);
  });
});

describe('completeDeviceLink', () => {
  test('seals this account keypair to the scanned key and sends it', async () => {
    await saveAccountKeypair(OLD_DEVICE, ACCOUNT_KEYPAIR);
    const started = await startDeviceLink();

    await completeDeviceLink(OLD_DEVICE, parseDeviceLinkPayload(started.payload));

    const [sessionId, sealed] = (sendDeviceLinkKeys as jest.Mock).mock.calls[0];
    expect(sessionId).toBe('session-1');
    // Sealed, not sent in the clear: the relay holds this blob.
    expect(sealed).not.toContain(toWire(ACCOUNT_KEYPAIR.secretKey));
  });

  // Two phones that both lost the keypair cannot make one out of nothing,
  // and minting one here would publish a key no circle can read.
  test('refuses when this device has no keypair either', async () => {
    const started = await startDeviceLink();

    await expect(completeDeviceLink(OLD_DEVICE, parseDeviceLinkPayload(started.payload))).rejects.toThrow(
      /no account keys/
    );
    expect(sendDeviceLinkKeys).not.toHaveBeenCalled();
  });
});

describe('collectDeviceLink', () => {
  /** Runs both halves against each other, which is the only way the sealing is really exercised. */
  async function handshake() {
    await saveAccountKeypair(OLD_DEVICE, ACCOUNT_KEYPAIR);
    const started = await startDeviceLink();
    await completeDeviceLink(OLD_DEVICE, parseDeviceLinkPayload(started.payload));
    const answered = {
      sessionId: started.sessionId,
      publicKey: toWire(started.keypair.publicKey),
      sealedKeypair: (sendDeviceLinkKeys as jest.Mock).mock.calls[0][1] as string,
      expiresAt: started.expiresAt,
    };
    (readDeviceLink as jest.Mock).mockResolvedValue(answered);
    return { session: { sessionId: started.sessionId, keypair: started.keypair }, answered };
  }

  test('opens what the other device sealed and saves it as this account keypair', async () => {
    const { session } = await handshake();

    const collected = await collectDeviceLink(NEW_DEVICE, session);

    expect(toWire(collected.secretKey)).toBe(toWire(ACCOUNT_KEYPAIR.secretKey));
    expect(toWire((await getAccountKeypair(NEW_DEVICE))!.publicKey)).toBe(toWire(ACCOUNT_KEYPAIR.publicKey));
  });

  // The other device's own sync can be behind, leaving it holding a
  // keypair the account has already replaced. Saving that looks like
  // success and then opens nothing.
  test('refuses a keypair the account no longer uses', async () => {
    const { session } = await handshake();
    (getProfile as jest.Mock).mockResolvedValue({
      accountId: NEW_DEVICE,
      name: 'Ali',
      createdAt: 0,
      publicKey: toWire(generateEphemeralKeypair().publicKey),
    });

    await expect(collectDeviceLink(NEW_DEVICE, session)).rejects.toThrow(/no longer uses/);
    expect(await getAccountKeypair(NEW_DEVICE)).toBeNull();
  });

  test('keeps polling until the other device answers', async () => {
    jest.useFakeTimers();
    try {
      const { session, answered } = await handshake();
      (readDeviceLink as jest.Mock)
        .mockResolvedValueOnce({ ...answered, sealedKeypair: undefined })
        .mockResolvedValueOnce(answered);

      const pending = collectDeviceLink(NEW_DEVICE, session);
      await jest.advanceTimersByTimeAsync(2_000);

      expect(toWire((await pending).secretKey)).toBe(toWire(ACCOUNT_KEYPAIR.secretKey));
      expect(readDeviceLink).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  // A screen that has gone away should stop asking rather than hold the
  // session open behind it.
  test('stops when the caller says to', async () => {
    const { session } = await handshake();

    await expect(collectDeviceLink(NEW_DEVICE, session, () => true)).rejects.toThrow(DeviceLinkGoneError);
    expect(readDeviceLink).not.toHaveBeenCalled();
  });
});
