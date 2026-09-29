import { getAnalytics, logEvent as rnfbLogEvent, logScreenView as rnfbLogScreenView } from '@react-native-firebase/analytics';

/** Fire-and-forget: logs a screen view. */
export async function logScreenView(screenName: string): Promise<void> {
  try {
    await rnfbLogScreenView(getAnalytics(), { screen_name: screenName, screen_class: screenName });
  } catch (err) {
    console.error('Failed to log screen view', err);
  }
}

/** Fire-and-forget: logs a named event, no params. */
export async function logEvent(name: string): Promise<void> {
  try {
    await rnfbLogEvent(getAnalytics(), name);
  } catch (err) {
    console.error('Failed to log analytics event', err);
  }
}
