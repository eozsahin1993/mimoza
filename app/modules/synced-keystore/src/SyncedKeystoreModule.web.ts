import { registerWebModule, NativeModule } from 'expo';

// No web equivalent of iCloud Keychain / Block Store sync — every call
// behaves as "never synced," which callers already treat as normal (the
// account falls back to the reset/reseal flow; see docs/RELAY_DESIGN.md).
class SyncedKeystoreModule extends NativeModule<Record<never, never>> {
  async setSynced(_key: string, value: string): Promise<string> {
    return value;
  }
  async getSynced(_key: string): Promise<string | null> {
    return null;
  }
  async deleteSynced(_key: string): Promise<void> {}
}

export default registerWebModule(SyncedKeystoreModule, 'SyncedKeystoreModule');
