import { NativeModule, requireNativeModule } from 'expo';

declare class SyncedKeystoreModule extends NativeModule<Record<never, never>> {
  setSynced(key: string, value: string): Promise<void>;
  getSynced(key: string): Promise<string | null>;
  deleteSynced(key: string): Promise<void>;
}

export default requireNativeModule<SyncedKeystoreModule>('SyncedKeystore');
