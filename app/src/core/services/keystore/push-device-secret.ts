import { bytesToHex, hexToBytes, randomBytes } from '@noble/curves/utils.js';

import { getSecret, setSecret } from '@/core/services/keystore/store';

const PUSH_DEVICE_SECRET_KEY = 'push_device_secret';

/**
 * This device's push secret, generated on first use. Every device id
 * derives from it, so it must not come from the master seed: devices share
 * that after a transfer and would all produce the same id, which is
 * exactly what lets the relay group them.
 */
export async function getPushDeviceSecret(): Promise<Uint8Array> {
  const stored = await getSecret(PUSH_DEVICE_SECRET_KEY);
  if (stored) return hexToBytes(stored);

  const secret = randomBytes(32);
  await setSecret(PUSH_DEVICE_SECRET_KEY, bytesToHex(secret));
  return secret;
}
