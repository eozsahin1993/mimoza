import { useEffect } from 'react';

import { loadOwnAccount, useOwnAccountStore } from '@/core/account/own-account-store';
import { useProfilePictureUri } from '@/core/photo/use-photo-uri';

export type OwnAccountView = {
  /** Undefined until the first read resolves, and when signed out. Doubles as the avatar colour seed. */
  accountId?: string;
  name?: string;
  pictureUri?: string;
};

/** This device's own account, kept current across profile edits and picture changes. */
export function useOwnAccount(): OwnAccountView {
  const account = useOwnAccountStore((s) => s.account);
  const loaded = useOwnAccountStore((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void loadOwnAccount();
  }, [loaded]);
  const pictureUri = useProfilePictureUri(account?.accountId);

  return { accountId: account?.accountId, name: account?.name, pictureUri };
}
