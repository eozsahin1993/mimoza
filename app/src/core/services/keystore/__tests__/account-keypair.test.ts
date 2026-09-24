import {
  ensureAccountKeypair,
  forgetAccountKeypair,
  getAccountKeypair,
  saveAccountKeypair,
} from '@/core/services/keystore/account-keypair';

jest.mock('@/core/services/keystore/synced-store');

const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';

afterEach(async () => {
  await forgetAccountKeypair(ACCOUNT_A);
  await forgetAccountKeypair(ACCOUNT_B);
});

describe('account keypair', () => {
  test('reads null before anything is stored', async () => {
    expect(await getAccountKeypair(ACCOUNT_A)).toBeNull();
  });

  test('mints a keypair the first time and reports it as created', async () => {
    const { keypair, created } = await ensureAccountKeypair(ACCOUNT_A);

    expect(created).toBe(true);
    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toHaveLength(32);
  });

  test('returns the same keypair on a second call, not created', async () => {
    const first = await ensureAccountKeypair(ACCOUNT_A);
    const second = await ensureAccountKeypair(ACCOUNT_A);

    expect(second.created).toBe(false);
    expect(second.keypair).toEqual(first.keypair);
  });

  test('round-trips the minted keypair through storage', async () => {
    const { keypair } = await ensureAccountKeypair(ACCOUNT_A);

    expect(await getAccountKeypair(ACCOUNT_A)).toEqual(keypair);
  });

  test('saveAccountKeypair overwrites the stored value', async () => {
    const { keypair: original } = await ensureAccountKeypair(ACCOUNT_A);
    const replacement = { ...original, publicKey: new Uint8Array(32).fill(9) };

    await saveAccountKeypair(ACCOUNT_A, replacement);

    expect(await getAccountKeypair(ACCOUNT_A)).toEqual(replacement);
  });

  test('forgetting clears the stored keypair', async () => {
    await ensureAccountKeypair(ACCOUNT_A);
    await forgetAccountKeypair(ACCOUNT_A);

    expect(await getAccountKeypair(ACCOUNT_A)).toBeNull();
  });

  test('two accounts on the same device do not share a keypair', async () => {
    const a = await ensureAccountKeypair(ACCOUNT_A);
    const b = await ensureAccountKeypair(ACCOUNT_B);

    expect(b.created).toBe(true);
    expect(b.keypair).not.toEqual(a.keypair);
    expect(await getAccountKeypair(ACCOUNT_A)).toEqual(a.keypair);
  });

  test('forgetting one account leaves the other untouched', async () => {
    await ensureAccountKeypair(ACCOUNT_A);
    const b = await ensureAccountKeypair(ACCOUNT_B);

    await forgetAccountKeypair(ACCOUNT_A);

    expect(await getAccountKeypair(ACCOUNT_A)).toBeNull();
    expect(await getAccountKeypair(ACCOUNT_B)).toEqual(b.keypair);
  });
});
