import { isCircleAdmin } from '@/features/invite/usecases/invite-to-circle';
import { publishCoverPhoto } from '@/features/circle/usecases/publish-cover-photo';

/** Sets (or replaces) a circle's cover photo — admin-only. */
export async function setCoverPhoto(circleId: string, photo: Uint8Array): Promise<void> {
  if (!(await isCircleAdmin(circleId))) throw new Error('Only an admin can set the cover photo.');
  await publishCoverPhoto(circleId, photo);
}
