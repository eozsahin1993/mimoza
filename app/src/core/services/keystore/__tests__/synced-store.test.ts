const mockGetSynced = jest.fn();
const mockSetSynced = jest.fn();

jest.mock('../../../../../modules/synced-keystore', () => ({
  __esModule: true,
  default: {
    getSynced: (...args: unknown[]) => mockGetSynced(...args),
    setSynced: (...args: unknown[]) => mockSetSynced(...args),
    deleteSynced: jest.fn(),
  },
}));

const mockLocalStore = new Map<string, string>();
jest.mock('@/core/services/keystore/store', () => ({
  getSecret: jest.fn(async (key: string) => mockLocalStore.get(key) ?? null),
  setSecret: jest.fn(async (key: string, value: string) => {
    mockLocalStore.set(key, value);
  }),
  deleteSecret: jest.fn(async (key: string) => {
    mockLocalStore.delete(key);
  }),
}));

import { getSyncedSecret, setSyncedSecret } from '@/core/services/keystore/synced-store';

beforeEach(() => {
  jest.useFakeTimers();
  mockGetSynced.mockReset();
  mockSetSynced.mockReset();
  mockLocalStore.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('getSyncedSecret: local copy first', () => {
  test('returns the local copy without ever asking the synced store', async () => {
    mockLocalStore.set('k', 'local-value');

    await expect(getSyncedSecret('k')).resolves.toBe('local-value');
    expect(mockGetSynced).not.toHaveBeenCalled();
  });

  // Block Store can resolve a write successfully while storing nothing
  // retrievable (see AGENTS.md) — the local copy is what get() actually
  // trusts, so a device that already wrote one here must never fall
  // through to the less reliable layer, however that layer behaves.
  test('a local copy wins even if the synced store would also answer', async () => {
    mockLocalStore.set('k', 'local-value');
    mockGetSynced.mockResolvedValue('synced-value');

    await expect(getSyncedSecret('k')).resolves.toBe('local-value');
    expect(mockGetSynced).not.toHaveBeenCalled();
  });
});

describe('getSyncedSecret: recovering from the synced store', () => {
  test('returns immediately when the first read finds something, and caches it locally', async () => {
    mockGetSynced.mockResolvedValue('found');

    await expect(getSyncedSecret('k')).resolves.toBe('found');
    expect(mockGetSynced).toHaveBeenCalledTimes(1);
    expect(mockLocalStore.get('k')).toBe('found');
  });

  test('retries past early misses and returns a later hit', async () => {
    mockGetSynced.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce('found');

    const promise = getSyncedSecret('k');
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBe('found');
    expect(mockGetSynced).toHaveBeenCalledTimes(3);
  });

  test('gives up after the last retry and reports absence, not an early guess', async () => {
    mockGetSynced.mockResolvedValue(null);

    const promise = getSyncedSecret('k');
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBeNull();
    expect(mockGetSynced).toHaveBeenCalledTimes(4); // 3 retries plus the final read
  });

  // A Keychain/Blockstore exception (not just "nothing found") must not
  // abort the search — this layer is a best-effort recovery path, and
  // the caller's real answer is "no local copy, nothing to recover".
  test('a synced read that throws is treated the same as a miss', async () => {
    mockGetSynced.mockRejectedValue(new Error('boom'));

    const promise = getSyncedSecret('k');
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBeNull();
  });
});

describe('setSyncedSecret', () => {
  test('writes locally even when the synced write fails', async () => {
    mockSetSynced.mockRejectedValue(new Error('Blockstore feature not enabled'));

    await expect(setSyncedSecret('k', 'v')).resolves.toBeUndefined();
    expect(mockLocalStore.get('k')).toBe('v');
  });
});
