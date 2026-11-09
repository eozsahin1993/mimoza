// synced-store wraps a native module with no bridge under Jest. This
// mock backs it with a plain in-memory Map, the same idiom as the root
// __mocks__/expo-secure-store.ts.
const store = new Map<string, string>();

export const getSyncedSecret = jest.fn(
  async (key: string, _options?: { waitForSync?: boolean }): Promise<string | null> => store.get(key) ?? null
);

export async function setSyncedSecret(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function deleteSyncedSecret(key: string): Promise<void> {
  store.delete(key);
}
