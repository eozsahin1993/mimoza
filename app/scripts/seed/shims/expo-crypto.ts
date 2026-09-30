/** Stands in for expo-crypto: only core/crypto/primitives.ts's generateUUID needs this. */
import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}
