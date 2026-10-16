import { create } from 'zustand';

import { getLocalAccount, getProfilePicture } from '@/data/db';
import { profilePictureUri } from '@/core/photo/photo-cache';
import { setProfilePictureUri } from '@/core/photo/photo-store';

/**
 * Who this device is signed in as, for every screen that shows "you":
 * the composer avatar on each feed card, the header on the circle list,
 * the account screen. One read of local_account for all of them rather
 * than one per mounted row, and one place a profile change lands so they
 * all follow it without a refocus.
 *
 * The picture itself lives in the photo store under this account id,
 * the same as anyone else's; loading here only seeds it from SQLite.
 */
export type OwnAccount = { accountId: string; name: string };

type OwnAccountStore = {
  account: OwnAccount | null;
  /** False until the first read has resolved — `null` before that means "not read yet", not "signed out". */
  loaded: boolean;
};

export const useOwnAccountStore = create<OwnAccountStore>()(() => ({ account: null, loaded: false }));

export function setOwnAccount(account: OwnAccount | null): void {
  useOwnAccountStore.setState({ account, loaded: true });
}

export function getOwnAccount(): OwnAccount | null {
  return useOwnAccountStore.getState().account;
}

/**
 * Only the dev reset changes the signed-in account within a running
 * process; ordinary sign-out keeps the local row, so it keeps this too.
 */
export function resetOwnAccountStore(): void {
  clearTimeout(retry);
  retry = undefined;
  failures = 0;
  useOwnAccountStore.setState({ account: null, loaded: false });
}

/** First retry waits this long; each further failure doubles it, up to `MAX_RETRY_MS`. */
const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

let inFlight: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

/**
 * Reads the local account once, however many hooks ask at the same
 * moment. Never rejects: a read that fails (the dev reset dropping the
 * schema under it, a transient SQLite error on cold start) is retried on
 * its own, since the hooks only ask again once `loaded` flips and a
 * failed read never flips it — a mounted screen would otherwise show no
 * name and no face until it happened to remount.
 */
export function loadOwnAccount(): Promise<void> {
  if (!inFlight) {
    clearTimeout(retry);
    retry = undefined;
    inFlight = read()
      .then(() => {
        failures = 0;
      })
      .catch((err) => {
        failures += 1;
        console.error(`Failed to read the local account (attempt ${failures})`, err);
        retry = setTimeout(() => void loadOwnAccount(), Math.min(BASE_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS));
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

async function read(): Promise<void> {
  const profile = await getLocalAccount();
  if (!profile) {
    setOwnAccount(null);
    return;
  }
  const picture = await getProfilePicture(profile.accountId);
  const uri = picture ? profilePictureUri(profile.accountId, picture) : null;
  if (uri) setProfilePictureUri(profile.accountId, uri);
  setOwnAccount({ accountId: profile.accountId, name: profile.name });
}
