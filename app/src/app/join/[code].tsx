import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { getLocalAccount } from '@/data/db';
import { getAuthToken } from '@/core/services/keystore/auth-token';
import { savePendingInviteCode } from '@/features/invite/services/pending-invite';

/**
 * Where an invite link lands, and nothing more: it parks the code and
 * sends you to the circle list, which opens the sheet over itself.
 *
 * Renders nothing on purpose. The join flow is a sheet, and a sheet needs
 * a screen behind it — as a route of its own it had none, so it either
 * floated on a bare background or had to rewrite the stack beneath itself
 * to invent one. Handing the code to a screen that already exists is that,
 * with no navigation left to get wrong.
 *
 * The signed-out path is the one it always was: index picks the code back
 * up after sign-in and profile setup.
 */
export default function JoinInviteScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();

  useEffect(() => {
    if (!code) return;

    (async () => {
      await savePendingInviteCode(code);
      const [token, profile] = await Promise.all([getAuthToken(), getLocalAccount()]);
      router.replace(token && profile ? '/circle' : '/');
    })();
  }, [code]);

  return null;
}
