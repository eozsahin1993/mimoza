import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { fromWire, toWire } from '@/core/crypto/content';
import { generateEphemeralKeypair, openSealedBox, sealToPublicKey } from '@/core/crypto/primitives';
import { DeviceLinkGoneError } from '@/core/services/relay-errors';
import { getAccountKeypair, saveAccountKeypair } from '@/core/services/keystore/account-keypair';
import {
  sendDeviceLinkKeys,
  getProfile as getRelayProfile,
  createDeviceLink,
  readDeviceLink,
} from '@/features/account/services/account-relay';
import type { Keypair } from '@/core/crypto/primitives';

/**
 * Handing this account's keypair from a phone that already has it to one
 * that does not, so a new device is in its circles immediately instead of
 * minting a fresh pair and waiting for every member to reseal.
 *
 * The waiting phone mints a throwaway keypair, opens a session with its
 * public half, and shows both in a QR code. The other phone scans it,
 * seals the real keypair to that key and posts the blob. The waiting
 * phone polls, opens it with the private half that never left it, and
 * saves.
 *
 * The public key travels in the QR rather than being fetched from the
 * relay on the answering side. That is the point: a relay that handed
 * over a key of its own would simply not be the one sealed to, so it
 * never holds anything it can open. It is a stronger position than the
 * rewrap path, which does take the relay's word for a member's key.
 */

/** Bumped only if the payload shape changes; an unknown version is refused rather than guessed at. */
const PAYLOAD_VERSION = 1;

const POLL_INTERVAL_MS = 2_000;

export type DeviceLinkPayload = {
  version: number;
  sessionId: string;
  /** The throwaway public key, base64, to seal the account keypair to. */
  publicKey: string;
};

export type StartedDeviceLink = {
  sessionId: string;
  /** Kept in memory only, for as long as the QR is on screen. */
  keypair: Keypair;
  /** What the QR encodes. */
  payload: string;
  expiresAt: number;
};

/**
 * The waiting phone's half. The throwaway keypair is returned rather than
 * stored: it is worth nothing after this handshake, and a session that is
 * abandoned should leave nothing behind.
 */
export async function startDeviceLink(): Promise<StartedDeviceLink> {
  const keypair = generateEphemeralKeypair();
  const publicKey = toWire(keypair.publicKey);
  const { sessionId, expiresAt } = await createDeviceLink(publicKey);
  const payload: DeviceLinkPayload = { version: PAYLOAD_VERSION, sessionId, publicKey };
  return { sessionId, keypair, payload: JSON.stringify(payload), expiresAt };
}

/**
 * Parses what a camera read. Anything that is not one of our codes throws
 * rather than reaching the relay — a QR is whatever happened to be in
 * frame, so this is the first thing that has to be sure.
 */
export function parseDeviceLinkPayload(data: string): DeviceLinkPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error('That is not a Mimoza device code.');
  }
  const payload = parsed as Partial<DeviceLinkPayload>;
  if (
    payload?.version !== PAYLOAD_VERSION ||
    typeof payload.sessionId !== 'string' ||
    typeof payload.publicKey !== 'string'
  ) {
    throw new Error('That is not a Mimoza device code.');
  }
  if (!payload.sessionId || fromWire(payload.publicKey).length !== PUBLIC_KEY_LENGTH) {
    throw new Error('That device code is damaged. Ask for a fresh one.');
  }
  return { version: payload.version, sessionId: payload.sessionId, publicKey: payload.publicKey };
}

const PUBLIC_KEY_LENGTH = 32;

/**
 * The answering phone's half: seal this account's keypair to the key that
 * was on screen, and post it.
 *
 * Throws rather than minting anything if this device has no keypair
 * either — two phones that both lost it cannot make one out of nothing,
 * and silently doing so would publish a key neither circle can read.
 */
export async function completeDeviceLink(accountId: string, payload: DeviceLinkPayload): Promise<void> {
  const keypair = await getAccountKeypair(accountId);
  if (!keypair) throw new Error('This device has no account keys to send.');

  const sealed = sealToPublicKey(serializeKeypair(keypair), fromWire(payload.publicKey));
  await sendDeviceLinkKeys(payload.sessionId, toWire(sealed));
}

/**
 * The waiting phone's poll. Resolves once the other device answers and
 * the keypair is saved; throws DeviceLinkGoneError when the session ages
 * out, which is the signal to show a fresh code rather than keep waiting.
 *
 * `shouldStop` is checked between polls so a screen that has gone away
 * stops asking, rather than holding the session open behind it.
 */
export async function collectDeviceLink(
  accountId: string,
  session: { sessionId: string; keypair: Keypair },
  shouldStop: () => boolean = () => false
): Promise<Keypair> {
  for (;;) {
    if (shouldStop()) throw new DeviceLinkGoneError();

    const link = await readDeviceLink(session.sessionId);
    if (link.sealedKeypair) {
      const keypair = openKeypair(link.sealedKeypair, session.keypair);
      await verifyMatchesAccount(keypair);
      await saveAccountKeypair(accountId, keypair);
      return keypair;
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * The keypair is sent as the same JSON the keystore holds, so what the
 * other device saves is byte for byte what this one had.
 */
function serializeKeypair(keypair: Keypair): Uint8Array {
  const json = JSON.stringify({
    publicKey: bytesToHex(keypair.publicKey),
    secretKey: bytesToHex(keypair.secretKey),
  });
  return new TextEncoder().encode(json);
}

function openKeypair(sealed: string, throwaway: Keypair): Keypair {
  const opened = openSealedBox(fromWire(sealed), throwaway);
  const parsed = JSON.parse(new TextDecoder().decode(opened)) as { publicKey?: string; secretKey?: string };
  if (!parsed.publicKey || !parsed.secretKey) throw new Error('The keys that arrived were not readable.');

  const keypair = { publicKey: hexToBytes(parsed.publicKey), secretKey: hexToBytes(parsed.secretKey) };
  if (keypair.publicKey.length !== PUBLIC_KEY_LENGTH || keypair.secretKey.length !== PUBLIC_KEY_LENGTH) {
    throw new Error('The keys that arrived were not readable.');
  }
  return keypair;
}

/**
 * The other device could be holding a keypair the account has already
 * replaced — its own sync may be behind. Saving that would look like
 * success and then open nothing, so it is refused here where it can still
 * be explained, rather than showing up later as circles that never load.
 */
async function verifyMatchesAccount(keypair: Keypair): Promise<void> {
  const profile = await getRelayProfile();
  if (profile.publicKey && profile.publicKey !== toWire(keypair.publicKey)) {
    throw new Error('The other device sent keys this account no longer uses.');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
