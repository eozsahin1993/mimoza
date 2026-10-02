import { generateUUID } from '@/core/crypto/primitives';
import { deleteProfilePicture, storeProfilePicture } from '@/data/db';
import { deleteProfilePictureFiles, writeProfilePictureFile } from '@/core/photo/photo-cache';
import { getProfilePictureUploadTarget, uploadBlob } from '@/core/services/blob-relay';
import { BlobAlreadyExistsError } from '@/core/services/relay-errors';
import { clearPicture, setPicture } from '@/features/account/services/account-relay';

/**
 * A fresh id every time, same reasoning as setCoverPhoto: content-addressed,
 * so a changed picture is a new id rather than bytes rewritten in place —
 * which is also what lets this seed the local row and cache file straight
 * from the bytes already in hand, rather than waiting on a roster sync to
 * report the id back and then downloading what was just uploaded.
 *
 * Nothing here touches localAccount: that table is this device's sign-in
 * state (name, deviceId), none of which a picture change ever affects.
 */
export async function publishProfilePicture(accountId: string, photo: Uint8Array): Promise<string> {
  const pictureId = generateUUID();

  await uploadBlob(await getProfilePictureUploadTarget(pictureId), photo).catch((err) => {
    // The first attempt actually landed; a retry just needs the relay told.
    if (!(err instanceof BlobAlreadyExistsError)) throw err;
  });
  await setPicture(pictureId);

  await storeProfilePicture(accountId, pictureId, photo);
  writeProfilePictureFile(accountId, photo, pictureId);

  return pictureId;
}

/** Takes the picture away again, on the relay and locally. */
export async function removeProfilePicture(accountId: string): Promise<void> {
  await clearPicture();

  await deleteProfilePicture(accountId);
  deleteProfilePictureFiles(accountId);
}
