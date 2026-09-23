import {
  ensureAccountKeypair,
  forgetAccountKeypair,
  getAccountKeypair,
  saveAccountKeypair,
} from '@/core/services/keystore/account-keypair';

jest.mock('@/core/services/keystore/synced-store');

afterEach(async () => {
  await forgetAccountKeypair();
});

describe('account keypair', () => {
  test('reads null before anything is stored', async () => {
    expect(await getAccountKeypair()).toBeNull();
  });

  test('mints a keypair the first time and reports it as created', async () => {
    const { keypair, created } = await ensureAccountKeypair();

    expect(created).toBe(true);
    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toHaveLength(32);
  });

  test('returns the same keypair on a second call, not created', async () => {
    const first = await ensureAccountKeypair();
    const second = await ensureAccountKeypair();

    expect(second.created).toBe(false);
    expect(second.keypair).toEqual(first.keypair);
  });

  test('round-trips the minted keypair through storage', async () => {
    const { keypair } = await ensureAccountKeypair();

    expect(await getAccountKeypair()).toEqual(keypair);
  });

  test('saveAccountKeypair overwrites the stored value', async () => {
    const { keypair: original } = await ensureAccountKeypair();
    const replacement = { ...original, publicKey: new Uint8Array(32).fill(9) };

    await saveAccountKeypair(replacement);

    expect(await getAccountKeypair()).toEqual(replacement);
  });

  test('forgetting clears the stored keypair', async () => {
    await ensureAccountKeypair();
    await forgetAccountKeypair();

    expect(await getAccountKeypair()).toBeNull();
  });
});
