jest.mock('@/core/services/blob-relay', () => ({
  getProfilePictureUploadTarget: jest.fn(async (pictureId: string) => ({ url: `https://s3/${pictureId}`, fields: {} })),
  uploadBlob: jest.fn(async () => undefined),
}));
jest.mock('@/features/account/services/account-relay', () => ({
  setPicture: jest.fn(async () => ({ accountId: 'acc-1', name: 'Ali', createdAt: 0 })),
  clearPicture: jest.fn(async () => ({ accountId: 'acc-1', name: 'Ali', createdAt: 0 })),
}));

import { initDatabase } from '@/data/db';
import { deleteProfilePicture, getProfilePicture } from '@/data/db/profile-pictures';
import { uploadBlob } from '@/core/services/blob-relay';
import { clearPicture, setPicture } from '@/features/account/services/account-relay';
import { BlobAlreadyExistsError } from '@/core/services/relay-errors';
import { publishProfilePicture, removeProfilePicture } from '@/features/account/usecases/set-profile-picture';

const ACCOUNT_ID = 'acc-1';

beforeAll(() => initDatabase());

beforeEach(async () => {
  jest.clearAllMocks();
  (setPicture as jest.Mock).mockResolvedValue({ accountId: ACCOUNT_ID, name: 'Ali', createdAt: 0 });
  (clearPicture as jest.Mock).mockResolvedValue({ accountId: ACCOUNT_ID, name: 'Ali', createdAt: 0 });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  await deleteProfilePicture(ACCOUNT_ID);
});

describe('publishProfilePicture', () => {
  test('uploads, tells the relay, and seeds the local row', async () => {
    const photo = new Uint8Array([1, 2, 3]);

    const pictureId = await publishProfilePicture(ACCOUNT_ID, photo);

    expect(setPicture).toHaveBeenCalledWith(pictureId);
    expect(uploadBlob).toHaveBeenCalledTimes(1);

    const stored = await getProfilePicture(ACCOUNT_ID);
    expect(stored?.pictureId).toBe(pictureId);
    expect(stored?.status).toBe('fetched');
    expect(stored?.bytes).toEqual(photo);
  });

  test('a fresh id every call, even for the same bytes', async () => {
    const photo = new Uint8Array([1, 2, 3]);

    const first = await publishProfilePicture(ACCOUNT_ID, photo);
    const second = await publishProfilePicture(ACCOUNT_ID, photo);

    expect(first).not.toBe(second);
  });

  // The first attempt actually landed; a retry just needs the relay told,
  // not a second upload of bytes already sitting at that key.
  test('a 409 on the upload is treated as already landed, not a failure', async () => {
    (uploadBlob as jest.Mock).mockRejectedValue(new BlobAlreadyExistsError());

    const pictureId = await publishProfilePicture(ACCOUNT_ID, new Uint8Array([1]));

    expect(setPicture).toHaveBeenCalledWith(pictureId);
  });

  test('a non-409 upload failure propagates and never reaches the relay', async () => {
    (uploadBlob as jest.Mock).mockRejectedValue(new Error('offline'));

    await expect(publishProfilePicture(ACCOUNT_ID, new Uint8Array([1]))).rejects.toThrow('offline');
    expect(setPicture).not.toHaveBeenCalled();
  });
});

describe('removeProfilePicture', () => {
  test('clears the relay and the local row', async () => {
    await publishProfilePicture(ACCOUNT_ID, new Uint8Array([1, 2, 3]));

    await removeProfilePicture(ACCOUNT_ID);

    expect(clearPicture).toHaveBeenCalledTimes(1);
    expect(await getProfilePicture(ACCOUNT_ID)).toBeNull();
  });
});
