import { decrypt, encryptJSON } from '@/core/crypto/primitives';

/**
 * What crosses the relay boundary: JSON sealed under a circle's content
 * key, carried as base64. The relay stores and returns it without ever
 * holding a key that opens it.
 *
 * There are no signatures here any more. The relay stamps the author
 * from the session, so a device no longer has to prove who wrote what —
 * which is the whole reason this file is two functions rather than a
 * verify-then-trust chokepoint.
 */
export function sealContent(value: unknown, key: Uint8Array): string {
  return toWire(encryptJSON(value, key));
}

/**
 * Null for every way content can be unusable — wrong key version,
 * tampered bytes, malformed JSON. Never throws, so one bad entry cannot
 * abort a sync pass; the caller logs it and walks past.
 */
export function openContent<T>(ciphertext: string, key: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(decrypt(fromWire(ciphertext), key))) as T;
  } catch {
    return null;
  }
}

/**
 * Key material as the relay carries it: base64, the same as ciphertext.
 *
 * Here rather than at each call site because the encoding is a property
 * of the boundary, not of whoever happens to be crossing it — and the
 * one time a call site chose for itself it chose hex, sealed every key
 * to a public key nobody held, and nothing noticed until a member simply
 * could not read.
 *
 * Reaction tags are the deliberate exception: they are path segments, and
 * base64 is not URL-safe, so those stay hex.
 */
export function toWire(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromWire(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}
