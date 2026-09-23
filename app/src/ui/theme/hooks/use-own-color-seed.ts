import { useEffect, useState } from 'react';

import { getProfile } from '@/data/db';

// Module-level, not per-hook-instance: `PostComments` mounts one of these
// per visible feed row, and every one of them wants the same value. Without
// this a long feed would fire one redundant SQLite read per row for a
// value that never differs between them.
let cached: string | undefined;
let inFlight: Promise<string | undefined> | null = null;

function load(): Promise<string | undefined> {
  if (!inFlight) {
    inFlight = getProfile()
      .then((profile) => {
        cached = profile?.accountId;
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Populates the cache directly from an already-known account id — for a
 * screen that has just signed in and would otherwise make every screen
 * mounted right after (circle list, account) re-read SQLite for a value
 * this process already has.
 */
export function primeOwnColorSeed(accountId: string): string {
  cached = accountId;
  return cached;
}

/**
 * Only the dev-only reset tool actually changes the signed-in account
 * within a running process (see dev-reset.ts) — ordinary sign-out
 * deliberately never touches it. Without clearing this, every mounted
 * screen would keep showing the previous account's colour until a real
 * app restart.
 */
export function clearOwnColorSeedCache(): void {
  cached = undefined;
}

/**
 * This device's own avatar-color seed: its account id, the same value
 * used to colour every other member's avatar — the relay already knows
 * who is in which circle, so there is nothing to protect by deriving a
 * separate seed the way `identity.ts` once had to when "your own"
 * identity was a different keypair per circle. Undefined until sign-in
 * has written a profile row.
 */
export function useOwnColorSeed(): string | undefined {
  const [seed, setSeed] = useState<string | undefined>(cached);

  useEffect(() => {
    if (cached !== undefined) return;
    load().then(setSeed);
  }, []);

  return seed;
}
