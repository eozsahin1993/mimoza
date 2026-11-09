import Constants from 'expo-constants';

type Extra = { inviteLinkBase?: string };

/** The link a member shares. https in staging and production (app.config.ts withInviteLinks); a dev build keeps the custom scheme. */
export function inviteLink(code: string): string {
  const base = (Constants.expoConfig?.extra as Extra | undefined)?.inviteLinkBase ?? 'mimoza://join/';
  return `${base}${code}`;
}
