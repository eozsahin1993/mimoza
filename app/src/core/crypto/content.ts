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
  return Buffer.from(encryptJSON(value, key)).toString('base64');
}

/**
 * Null for every way content can be unusable — wrong key version,
 * tampered bytes, malformed JSON. Never throws, so one bad entry cannot
 * abort a sync pass; the caller logs it and walks past.
 */
export function openContent<T>(ciphertext: string, key: Uint8Array): T | null {
  try {
    const bytes = new Uint8Array(Buffer.from(ciphertext, 'base64'));
    return JSON.parse(new TextDecoder().decode(decrypt(bytes, key))) as T;
  } catch {
    return null;
  }
}
