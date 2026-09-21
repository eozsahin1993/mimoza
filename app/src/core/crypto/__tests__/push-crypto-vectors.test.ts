import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { openSealedBox, sign, verify } from '@/core/crypto/primitives';
import { deriveCircleIdentity, derivePushRoutingId } from '@/core/crypto/identity';
import { buildLogEntry, verifyLogEntry } from '@/core/sync/log-entry';

/**
 * Pins the exact bytes the Swift port in
 * targets/notification-service/CircleCrypto.swift must reproduce — the
 * reference for verifying that side, which has no test target of its own
 * (the generated Xcode project can't durably hold one).
 */

const seed = new Uint8Array(16).fill(1);
const contentKey = new Uint8Array(32).fill(2);
const nonce = new Uint8Array(24).fill(3);
const circleId = 'vector-circle';

test('routing id vector', () => {
  expect(derivePushRoutingId(seed, circleId)).toBe('42840a8d4ad2b7b7b8bb3d180ade5ca23f2f4589d39439ae4890895986aaaa71');
});

test('envelope vector decrypts and verifies', () => {
  const identity = deriveCircleIdentity(seed, circleId);
  const envelope = buildLogEntry(
    'comment',
    { commentId: 'c-1', postId: 'p-1', body: 'hello', createdAt: 1700000000000 },
    identity,
  );
  // encrypt() picks a random nonce; the vector needs a fixed one, so the
  // wire format (nonce || box) is assembled here the same way.
  const box = concatBytes(nonce, xchacha20poly1305(contentKey, nonce).encrypt(envelope));

  expect(bytesToHex(identity.publicKey)).toBe('2fe1c922370472c19cd96d90e785cc83d16c46a341870686f2e40c0841233983');
  expect(bytesToHex(box)).toBe('030303030303030303030303030303030303030303030303262b55264d3618bda250e8a359ea168dbb5df142eff79c7d2fcd823912fa473beb94f9443a1c11099f0a3737ee921a52352dafa2ade971d901ddb745a90ca4b05a325a6fc62ff33ae3eeb4b8bc68486262d124eb7f3d81b1b76aaf232fc533cdcdce8eaa3ec9f4a14117a6fc8277e34d2c366e610cbe7a2f84718f1e4f4974770bd547b55aaf2335d1d9ea0a992310807515a456f696446159fd0cef73f638d623d539d418bc03c31e200615fb0360d620a29a83c74f75c4f899f3527de49a14c02ce0f53ca511c3c7928d40a17adc807c68aee6c16454b9e820cd630276a2f9934b7e56e613e80e40b2055d685e1f180fcecd728ecb82b05bc3a49be36a205f3501a8fc2f7141a6941e32791adecf06a73e5ccfc8d8ad9210c53a8805ff97baaf5ec4c47a877099811f477c354996b77b1cad091d4d72a8a04057d41bffe488200d9b63877d142fe61bda616f348ede203aaa948975f7b7d5');

  const verified = verifyLogEntry(box, contentKey);
  expect(verified?.type).toBe('comment');
  expect((verified?.payload as { body: string }).body).toBe('hello');
});

test('a signed prefix cut at the last authorPubkey marker verifies', () => {
  // The Swift port extracts the signed message textually from the
  // plaintext instead of re-serializing JSON — this proves that recipe
  // against the same signature the JS side checks.
  const identity = deriveCircleIdentity(seed, circleId);
  const envelope = buildLogEntry('comment', { body: 'x,"authorPubkey":"decoy' }, identity);
  const text = new TextDecoder().decode(envelope);
  const marker = text.lastIndexOf(',"authorPubkey":"');
  const message = new TextEncoder().encode(text.slice(0, marker) + '}');
  const parsed = JSON.parse(text) as { signature: string; authorPubkey: string };
  expect(
    verify(
      Uint8Array.from(Buffer.from(parsed.signature, 'hex')),
      message,
      Uint8Array.from(Buffer.from(parsed.authorPubkey, 'hex')),
    ),
  ).toBe(true);
});

test('sealed approval vector opens and verifies', () => {
  // sealToPublicKey picks its own sender key and nonce; the vector fixes
  // both, so the wire format is assembled here and checked against the
  // real openSealedBox.
  const recipient = { secretKey: new Uint8Array(32).fill(4), publicKey: x25519.getPublicKey(new Uint8Array(32).fill(4)) };
  const senderSecret = new Uint8Array(32).fill(5);
  const senderPublic = x25519.getPublicKey(senderSecret);
  const creator = deriveCircleIdentity(seed, circleId);
  const approval = { keyMap: { 1: '02'.repeat(32) }, syncId: 'sync-1', circleName: 'Family' };
  const envelope = { approval, signature: bytesToHex(sign(new TextEncoder().encode(JSON.stringify(approval)), creator.secretKey)) };
  const key = hkdf(sha256, x25519.getSharedSecret(senderSecret, recipient.publicKey), undefined, concatBytes(new TextEncoder().encode('join-approval-box'), senderPublic, recipient.publicKey), 32);
  const approvalNonce = new Uint8Array(24).fill(6);
  const sealed = concatBytes(senderPublic, approvalNonce, xchacha20poly1305(key, approvalNonce).encrypt(new TextEncoder().encode(JSON.stringify(envelope))));

  expect(bytesToHex(key)).toBe('191d40e75151b6a90f0fb3f45e70c675ac5333371fe2691b5d5515bdbde1bc29');
  expect(bytesToHex(sealed)).toBe('50a61409b1ddd0325e9b16b700e719e9772c07000b1bd7786e907c653d20495d060606060606060606060606060606060606060606060606263f0e628489644428f2a89d757678a43339c2a7598176cb5cf1c62924d95fa4d95772aeb06801b9742c02d044daf83f48ec0239e243297cf619692378d429ae00ce47c03e87bb75b00243f3eebfaae6b3426f41d06b9e75f65aa385719fe98c0b4bf82d3b1a770f237867d18f5cac29b1ac97ee65f18e41490b6e3c6ba59e709a4c094a3ecf44cbb44dd96d49668b0aca6a26f26003cc88613bae2fed7d9c5a0fb95030f0888aa549e2c5054f249a4e65468e234d33813b57628877fd2f611ccf0ba02a68832219332d4dc104e6d7d7ae243c3cbb42406a9f2f1a46aba15aa8332a3bc8602e3f6650d099ceda57972eb83d98ee4961099a88c2804f36955d831013ae65afb4eba8b24ef7f21784f6d24b0954536d4f71513a52705ad8822e20507af9b76d15a6');

  // The Swift port verifies the text between `{"approval":` and the last
  // `,"signature":"`, rather than re-serializing.
  const text = new TextDecoder().decode(openSealedBox(sealed, recipient));
  const message = new TextEncoder().encode(text.slice('{"approval":'.length, text.lastIndexOf(',"signature":"')));
  expect(verify(hexToBytes(envelope.signature), message, creator.publicKey)).toBe(true);
});
