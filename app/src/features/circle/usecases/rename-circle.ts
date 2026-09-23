import { renameCircle as renameLocally } from '@/data/db';
import { renameCircle as renameOnRelay } from '@/features/circle/services/circle-relay';

/**
 * Admin-only, enforced by the relay; the wall gets a `renamed` entry.
 *
 * Trimmed and refused when blank: the relay reads an empty name as
 * "leave this field alone", so whitespace would sail past that guard and
 * become the circle's name for everyone.
 */
export async function renameCircle(circleId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A circle needs a name.');

  await renameOnRelay(circleId, trimmed);
  await renameLocally(circleId, trimmed);
}
