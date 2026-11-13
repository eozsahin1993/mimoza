import Constants from 'expo-constants';

type Extra = { inviteLinkBase?: string };

/** The link a member shares. https in staging and production (app.config.ts withInviteLinks); a dev build keeps the custom scheme. */
export function inviteLink(code: string): string {
  const base = (Constants.expoConfig?.extra as Extra | undefined)?.inviteLinkBase ?? 'mimoza://join/';
  return `${base}${code}`;
}

// Every shape inviteLink has produced in any environment, including the
// custom-scheme links older builds still show as QR codes.
const INVITE_LINK = /^(?:https:\/\/joinmimoza\.com(?:\/staging)?\/join|mimoza(?:-staging)?:\/\/join)\/([a-z0-9]+)\/?$/i;

/**
 * The invite code inside a scanned link, or null when it isn't an invite.
 * Says nothing about whether the code still works; the relay decides that.
 */
export function inviteCodeFromLink(scanned: string): string | null {
  return INVITE_LINK.exec(scanned.trim())?.[1] ?? null;
}
