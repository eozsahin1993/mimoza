import { authorizedFetch, describeError } from '@/core/services/relay';

/** How much a circle may interrupt this account. Set through the member's own row — see docs/RELAY_DESIGN.md. */
export type NotifyLevel = 'all' | 'comments' | 'photos' | 'none';

/** Always the caller's own row: the relay refuses anyone else's notifyLevel. */
export async function setNotifyLevel(circleId: string, accountId: string, notifyLevel: NotifyLevel): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/members/${accountId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notifyLevel }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'setting the notification level'));
}
