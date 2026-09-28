import { getCrashlytics, log, recordError as rnfbRecordError } from '@react-native-firebase/crashlytics';

/** Starts native crash capture. Constructing the module also installs Crashlytics' own global JS exception handler, chained onto whatever handler was already there. */
export function initCrashReporting(): void {
  try {
    getCrashlytics();
  } catch (err) {
    console.error('Failed to start crash reporting', err);
  }
}

/** Reports a caught error that didn't crash the app but is still worth knowing about. */
export async function recordError(error: unknown, context?: string): Promise<void> {
  try {
    const crashlytics = getCrashlytics();
    if (context) log(crashlytics, context);
    await rnfbRecordError(crashlytics, error instanceof Error ? error : new Error(String(error)));
  } catch (err) {
    console.error('Failed to record error to Crashlytics', err);
  }
}
