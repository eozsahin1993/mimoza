import {
  forgetAccountKeypair,
  getAccountKeypair,
  mintAndSaveAccountKeypair,
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

  test('mints a keypair with both halves present', async () => {
    const keypair = await mintAndSaveAccountKeypair(ACCOUNT_A);

    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toHaveLength(32);
  });

  test('minting again overwrites the previous keypair', async () => {
    const first = await mintAndSaveAccountKeypair(ACCOUNT_A);
    const second = await mintAndSaveAccountKeypair(ACCOUNT_A);

    expect(second).not.toEqual(first);
    expect(await getAccountKeypair(ACCOUNT_A)).toEqual(second);
  });

  test('round-trips the minted keypair through storage', async () => {
    const keypair = await mintAndSaveAccountKeypair(ACCOUNT_A);

    expect(await getAccountKeypair(ACCOUNT_A)).toEqual(keypair);
  });

  test('saveAccountKeypair overwrites the stored value', async () => {
    const original = await mintAndSaveAccountKeypair(ACCOUNT_A);
    const replacement = { ...original, publicKey: new Uint8Array(32).fill(9) };

    await saveAccountKeypair(ACCOUNT_A, replacement);

    expect(await getAccountKeypair(ACCOUNT_A)).toEqual(replacement);
  });

  test('forgetting clears the stored keypair', async () => {
    await mintAndSaveAccountKeypair(ACCOUNT_A);
    await forgetAccountKeypair(ACCOUNT_A);

    expect(await getAccountKeypair(ACCOUNT_A)).toBeNull();
  });

  test('two accounts on the same device do not share a keypair', async () => {
    const a = await mintAndSaveAccountKeypair(ACCOUNT_A);
    const b = await mintAndSaveAccountKeypair(ACCOUNT_B);

    expect(b).not.toEqual(a);
    expect(await getAccountKeypair(ACCOUNT_A)).toEqual(a);
  });

  test('forgetting one account leaves the other untouched', async () => {
    await mintAndSaveAccountKeypair(ACCOUNT_A);
    const b = await mintAndSaveAccountKeypair(ACCOUNT_B);

    await forgetAccountKeypair(ACCOUNT_A);

    expect(await getAccountKeypair(ACCOUNT_A)).toBeNull();
    expect(await getAccountKeypair(ACCOUNT_B)).toEqual(b);
  });
});
