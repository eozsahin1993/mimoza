import { AppState, type AppStateStatus } from 'react-native';

import { getAuthToken } from '@/core/services/keystore/auth-token';
import { nudgePhotoQueue } from '@/core/photo/photo-queue';
import { syncCircles } from '@/core/sync/sync-circles';

/** How often to check in while the app is open. Timers don't fire in the background, so this is a foreground cadence. */
const FOREGROUND_INTERVAL_MS = 30_000;

/** Only one pass at a time; concurrent triggers await the running one instead of starting a second. */
let inFlight: Promise<void> | null = null;

/**
 * One sync pass, then the photo queue set going without waiting for it.
 *
 * Deduped: the app has several independent reasons to check in
 * (foreground, a timer, a pull-to-refresh, a background task) and they
 * routinely coincide. A second caller joins the pass already running
 * rather than racing it — two concurrent walks would fight over the same
 * cursors.
 */
export function runSync(): Promise<void> {
  if (!inFlight) {
    inFlight = syncIfSignedIn()
      .catch((err) => console.error('Sync pass failed', err))
      .finally(() => {
        inFlight = null;
      });
  }

  const pass = inFlight;
  // Fire-and-forget: photos must never hold up whatever is awaiting the pass.
  pass.then(() => nudgePhotoQueue());
  return pass;
}

/** Signed out, every relay route would refuse the pass, so there's no pass to run. */
async function syncIfSignedIn(): Promise<void> {
  if (await getAuthToken()) await syncCircles();
}

/**
 * Starts the background sync triggers and returns a function that stops
 * them. Call once, from the root layout.
 *
 * Three triggers, all foreground: once on startup, on every return to the
 * foreground (where new content is most likely waiting), and on a timer
 * while the app stays open. iOS has no sync-adapter equivalent, so
 * anything genuinely background is best-effort and additive on top of
 * these, never a replacement for them.
 *
 * Safe to start before sign-in, and left running across sign-out: every
 * trigger checks for a session first and does nothing without one, so
 * signing back in resumes it without a restart.
 */
export function startSyncScheduler(): () => void {
  runSync();

  const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') runSync();
  });
  const interval = setInterval(runSync, FOREGROUND_INTERVAL_MS);

  return () => {
    subscription.remove();
    clearInterval(interval);
  };
}
