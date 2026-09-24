import { deleteSecret, getSecret, setSecret } from '@/core/services/keystore/store';
import SyncedKeystore from '../../../../modules/synced-keystore';

/**
 * Dev-only: puts each half of synced-store's local/synced pair on `global`
 * so they can be called directly from the JS debugger console. Needed
 * because synced-store.ts's local-first fast path makes it otherwise
 * impossible to exercise a synced-only read without actually deleting the
 * local copy first — there's no way to ask "what does Blockstore/Keychain
 * alone have for this key" through the normal API.
 */
export function installDebugKeystore(): void {
  if (!__DEV__) return;
  (global as Record<string, unknown>).debugKeystore = {
    getLocal: getSecret,
    setLocal: setSecret,
    deleteLocal: deleteSecret,
    // Bound explicitly: these are native-module methods, and extracting
    // them as bare references off SyncedKeystore would otherwise risk
    // losing whatever `this` the underlying native proxy relies on.
    getSynced: SyncedKeystore.getSynced.bind(SyncedKeystore),
    setSynced: SyncedKeystore.setSynced.bind(SyncedKeystore),
    deleteSynced: SyncedKeystore.deleteSynced.bind(SyncedKeystore),
  };
}
