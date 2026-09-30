/**
 * "45m", "3h", "2d", "1w", "6mo", "1y" relative to now, so the fixture never
 * goes stale — or an absolute local date like "2025-12-25T15:23" for the
 * moments that only make sense on their own day.
 */
export function resolveAgo(ago: string | undefined, now: number): number {
  if (!ago) throw new Error('Missing "ago" value — every post and comment needs one (want e.g. "2h", "3d", "1w", "6mo", or "2025-12-25T15:23").');
  const value = ago.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const absolute = Date.parse(value);
    if (Number.isNaN(absolute)) throw new Error(`Bad "ago" date: "${ago}" (want e.g. "2025-12-25" or "2025-12-25T15:23")`);
    return absolute;
  }
  const match = /^(\d+)(mo|m|h|d|w|y)$/.exec(value);
  if (!match) throw new Error(`Bad "ago" value: "${ago}" (want e.g. "2h", "3d", "1w", "6mo", "1y", or "2025-12-25T15:23")`);
  const amount = Number(match[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 30 * 86_400_000, y: 365 * 86_400_000 }[match[2] as 'm' | 'h' | 'd' | 'w' | 'mo' | 'y'];
  return now - amount * unitMs;
}
