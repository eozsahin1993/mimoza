/**
 * Stands in for src/core/services/relay.ts: the app assumes one signed-in
 * account per device, but a seeding run drives many at once. `asAccount`
 * sets which one's token the next calls carry — the real *-relay.ts
 * modules are imported verbatim against this, so every request shape and
 * crypto step is byte-for-byte what the app itself would send.
 */

let activeToken: string | null = null;
let base = process.env.SEED_RELAY_URL ?? 'http://127.0.0.1:8099';

export function configureRelay(url: string): void {
  base = url;
}

export function asAccount<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const previous = activeToken;
  activeToken = token;
  return fn().finally(() => {
    activeToken = previous;
  });
}

/** Node reaches the host directly, so a presigned link needs no rewriting here. */
export function reachableFromThisDevice(url: string): string {
  return url;
}

export function baseUrl(): string {
  return base;
}

export async function describeError(response: Response, summary: string): Promise<string> {
  const text = await response.text().catch(() => '');
  let detail = text;
  try {
    const body = JSON.parse(text);
    if (typeof body?.error === 'string' && body.error) detail = body.error;
  } catch {
    // not JSON — use the raw text as-is
  }
  return detail ? `${summary}: ${response.status} ${detail}` : `${summary}: ${response.status}`;
}

export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!activeToken) throw new Error(`No active seed account for ${path} — call inside asAccount().`);
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${activeToken}` },
  });
}
