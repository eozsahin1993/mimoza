import { x25519 } from '@noble/curves/ed25519.js';

import { openSealedBox, sealToPublicKey } from '@/core/crypto/primitives';
import { resealFor, storeSealedKeys } from '@/features/circle/usecases/key-exchange';
import type { RosterMember } from '@/features/circle/services/circle-relay';

jest.mock('@/features/circle/services/circle-relay', () => ({ rewrapKeys: jest.fn(async () => undefined) }));

const mockKeys: Record<string, Record<number, Uint8Array>> = {};
jest.mock('@/core/services/keystore/circle-keys', () => ({
  getCircleKeyMap: jest.fn(async (circleId: string) => mockKeys[circleId] ?? null),
  saveCircleKeyMap: jest.fn(async (circleId: string, keys: Record<number, Uint8Array>) => {
    mockKeys[circleId] = keys;
  }),
}));

const mockMe = x25519.keygen();
jest.mock('@/core/services/keystore/account-keypair', () => ({ getAccountKeypair: jest.fn(async () => mockMe) }));

const relay = jest.requireMock('@/features/circle/services/circle-relay') as { rewrapKeys: jest.Mock };

const CONTENT_V1 = new Uint8Array(32).fill(1);
const CONTENT_V2 = new Uint8Array(32).fill(2);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockKeys)) delete mockKeys[key];
});

describe('taking in the keys sealed to this account', () => {
  test('opens every version the roster carried', async () => {
    await storeSealedKeys('c1', {
      1: b64(sealToPublicKey(CONTENT_V1, mockMe.publicKey)),
      2: b64(sealToPublicKey(CONTENT_V2, mockMe.publicKey)),
    });

    expect(mockKeys.c1[1]).toEqual(CONTENT_V1);
    expect(mockKeys.c1[2]).toEqual(CONTENT_V2);
  });

  // Sealed to a keypair this device replaced. A member reseals it once
  // they see needsRewrap; failing the whole sync over it would strand
  // the versions that do open.
  test('a version that will not open is skipped, and the rest still land', async () => {
    const someoneElse = x25519.keygen();

    await storeSealedKeys('c1', {
      1: b64(sealToPublicKey(CONTENT_V1, mockMe.publicKey)),
      2: b64(sealToPublicKey(CONTENT_V2, someoneElse.publicKey)),
    });

    expect(mockKeys.c1[1]).toEqual(CONTENT_V1);
    expect(mockKeys.c1[2]).toBeUndefined();
  });

  test('a version already held is left alone', async () => {
    mockKeys.c1 = { 1: CONTENT_V1 };

    await storeSealedKeys('c1', { 1: b64(sealToPublicKey(new Uint8Array(32).fill(9), mockMe.publicKey)) });

    expect(mockKeys.c1[1]).toEqual(CONTENT_V1);
  });
});

describe('resealing for a member who replaced their keypair', () => {
  function member(publicKey: Uint8Array): RosterMember {
    return {
      accountId: 'ali',
      publicKey: b64(publicKey),
      role: 'member',
      notifyLevel: 'all',
      joinedAt: 0,
      needsRewrap: true,
    };
  }

  // The roster publishes a key as base64, the keychain stores one as
  // hex. Reading the wire as hex would seal to a key nobody holds, and
  // nothing downstream would notice until the member could not read.
  test('what it seals is openable by the key the roster published', async () => {
    mockKeys.c1 = { 1: CONTENT_V1, 2: CONTENT_V2 };
    const ali = x25519.keygen();

    await resealFor('c1', member(ali.publicKey));

    const [, accountId, sealed] = relay.rewrapKeys.mock.calls[0];
    expect(accountId).toBe('ali');
    expect(openSealedBox(new Uint8Array(Buffer.from(sealed['1'], 'base64')), ali)).toEqual(CONTENT_V1);
    expect(openSealedBox(new Uint8Array(Buffer.from(sealed['2'], 'base64')), ali)).toEqual(CONTENT_V2);
  });

  test('every version held goes, not just the current one', async () => {
    mockKeys.c1 = { 1: CONTENT_V1, 2: CONTENT_V2 };

    await resealFor('c1', member(x25519.keygen().publicKey));

    expect(Object.keys(relay.rewrapKeys.mock.calls[0][2]).sort()).toEqual(['1', '2']);
  });

  test('holding no keys means there is nothing to offer', async () => {
    await resealFor('c1', member(x25519.keygen().publicKey));

    expect(relay.rewrapKeys).not.toHaveBeenCalled();
  });
});
