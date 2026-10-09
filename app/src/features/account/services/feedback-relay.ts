import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { currentLanguage } from '@/core/i18n/i18n';
import { appEnvironment, appVersion, buildNumbers } from '@/core/services/build-info';
import { RateLimitedError } from '@/core/services/relay-errors';
import { authorizedFetch, relayError } from '@/core/services/relay';

/**
 * What someone sends from the feedback screen — POST /v1/feedback, see
 * server/internal/feedback/submit. The relay stores it and emails it on;
 * the one thing it stores that a person wrote for us to read.
 */

export type FeedbackKind = 'bug' | 'content' | 'feedback';

/**
 * What the app knows about itself, sent beside the message. Built here
 * rather than on the relay, which sees only a session, and shown on the
 * screen before sending so nothing travels unseen. Nothing in it names a
 * circle or a post.
 */
export type FeedbackContext = {
  appVersion: string;
  build: string;
  platform: string;
  osVersion: string;
  device: string;
  language: string;
  environment: string;
};

export function feedbackContext(): FeedbackContext {
  return {
    appVersion,
    build: buildNumbers() ?? '',
    // "iOS" rather than "ios": this is read by a person, in the email
    // and on the screen before sending.
    platform: Device.osName ?? Platform.OS,
    osVersion: Device.osVersion ?? '',
    // The marketing name where the OS gives one ("iPhone 15 Pro"), the
    // identifier otherwise — Android reports both inconsistently.
    device: Device.modelName ?? Device.modelId ?? '',
    language: currentLanguage(),
    environment: appEnvironment ?? '',
  };
}

export type Feedback = {
  kind: FeedbackKind;
  message: string;
  /** Where we may reply. Empty when the person left it blank. */
  email: string;
  context: FeedbackContext;
};

export async function sendFeedback(feedback: Feedback): Promise<{ reportId: string }> {
  const response = await authorizedFetch('/v1/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(feedback),
  });
  // Named, because the screen says something different for it: the
  // feedback budget is a handful per window, so a person can hit it.
  if (response.status === 429) throw new RateLimitedError();
  if (!response.ok) throw await relayError(response, 'sending feedback');
  return (await response.json()) as { reportId: string };
}
