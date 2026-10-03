import { getCircle, type Circle } from '@/data/db';

/**
 * The circle, if this account is still in it. A circle that was removed
 * from under this account stays on the device as a read-only archive,
 * and the relay would refuse any write to it as not-a-member; every use
 * case that writes starts here so the refusal is local and immediate
 * rather than five relay attempts and a banner later.
 */
export async function requireLiveCircle(circleId: string): Promise<Circle> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error(`No circle ${circleId} on this device.`);
  if (circle.leftAt !== null) throw new Error(`No longer a member of circle ${circleId}.`);
  return circle;
}
