import { Buffer } from 'buffer';
import { bytesToHex } from '@noble/curves/utils.js';

import { type AuthorityAction } from '@/core/crypto/signed-messages';
import { authorizedFetch, describeError } from '@/core/services/relay';
import { CircleGoneError, RateLimitedError } from '@/core/services/relay-errors';

/**
 * The relay's circle-log endpoints (server-side: server/internal/synclog/http's
 * createlog, appendlog, rotatelog, changeauthority, deletecircle, getlog,
 * getepochs). No retry/queueing logic here; that's sync-circle.ts's job.
 */

export type Namespace = 'meta' | 'content';

export type AppendResult = {
  epoch: number;
  receivedAt: number;
};

export type LogEntry = {
  epoch: number;
  /** Plaintext — which content-key version `encryptedMeta` was encrypted under, for direct lookup instead of trial-decryption. */
  keyVersion: number;
  encryptedMeta: Uint8Array;
  receivedAt: number;
  /** Set only on a deleted post — empty `encryptedMeta`, nothing to decrypt */
  deletedAt?: number;
};

export type FetchEntriesResult = {
  entries: LogEntry[];
  currentEpoch: number;
};

/**
 * Creates a circle's control state — POST /v1/circles/{syncId}. Nothing
 * else is written here: the founder's own member_added entry is a
 * separate, subsequent `appendEntry` call using the token this registers.
 */
export async function bootstrapCircle(syncId: string, founderAuthorityPublicKey: Uint8Array, initialWriteTokenHash: string): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${syncId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      founderAuthorityPublicKey: bytesToHex(founderAuthorityPublicKey),
      initialWriteTokenHash,
    }),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to create circle'));
  }
}

/**
 * Appends one entry to a circle's log — POST /v1/circles/{syncId}/entries.
 * `keyVersion` is sent as plaintext alongside the ciphertext (not part of
 * it) — which content key `encryptedMeta` was actually encrypted under,
 * so a reader can pick the right key by direct lookup rather than
 * trial-decrypting with every version it holds.
 */
export async function appendEntry(
  syncId: string,
  namespace: Namespace,
  entryId: string,
  encryptedMeta: Uint8Array,
  keyVersion: number,
  writeToken: Uint8Array,
  authorIdentityPublicKey: Uint8Array
): Promise<AppendResult> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      namespace,
      entryId,
      encryptedMeta: Buffer.from(encryptedMeta).toString('base64'),
      keyVersion,
      writeToken: bytesToHex(writeToken),
      authorIdentityPublicKey: bytesToHex(authorIdentityPublicKey),
    }),
  });
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to append entry'));
  }
  const body = await response.json();
  return { epoch: body.epoch, receivedAt: body.receivedAt };
}

/**
 * Rotates a circle's write token — POST /v1/circles/{syncId}/rotate.
 * Appends the key_rotation meta entry and swaps in the new write token in
 * one atomic transaction, so a client can never observe one without the
 * other. `signature` must verify against `deriveRotateMessage(syncId,
 * entryId, newWriteTokenHash)` — see crypto.ts.
 */
export async function rotateLog(
  syncId: string,
  entryId: string,
  encryptedMeta: Uint8Array,
  currentKeyVersion: number,
  currentWriteToken: Uint8Array,
  newWriteTokenHash: string,
  authorityPublicKey: Uint8Array,
  signature: Uint8Array
): Promise<AppendResult> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entryId,
      encryptedMeta: Buffer.from(encryptedMeta).toString('base64'),
      currentKeyVersion,
      currentWriteToken: bytesToHex(currentWriteToken),
      newWriteTokenHash,
      authorityPublicKey: bytesToHex(authorityPublicKey),
      signature: bytesToHex(signature),
    }),
  });
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to rotate'));
  }
  const body = await response.json();
  return { epoch: body.epoch, receivedAt: body.receivedAt };
}

/**
 * Adds or removes a key from a circle's authority set — POST
 * /v1/circles/{syncId}/authority. Appends the role_change meta entry and
 * mutates the set atomically, the same way `rotateLog` pairs an entry
 * with its token swap; the relay refuses to do one without the other.
 * `signature` must verify against `deriveAuthorityChangeMessage(action,
 * syncId, entryId, targetAuthorityPublicKey)` — see crypto.ts.
 *
 * The signer must already be in the set, and cannot name their own key
 * for removal — see `ErrCannotRemoveSelf` on the relay.
 */
export async function changeAuthority(change: {
  syncId: string;
  entryId: string;
  encryptedMeta: Uint8Array;
  keyVersion: number;
  writeToken: Uint8Array;
  action: AuthorityAction;
  targetAuthorityPublicKey: Uint8Array;
  signerAuthorityPublicKey: Uint8Array;
  signature: Uint8Array;
}): Promise<AppendResult> {
  const response = await authorizedFetch(`/v1/circles/${change.syncId}/authority`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entryId: change.entryId,
      encryptedMeta: Buffer.from(change.encryptedMeta).toString('base64'),
      keyVersion: change.keyVersion,
      writeToken: bytesToHex(change.writeToken),
      action: change.action,
      targetAuthorityPublicKey: bytesToHex(change.targetAuthorityPublicKey),
      signerAuthorityPublicKey: bytesToHex(change.signerAuthorityPublicKey),
      signature: bytesToHex(change.signature),
    }),
  });
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to change authority'));
  }
  const body = await response.json();
  return { epoch: body.epoch, receivedAt: body.receivedAt };
}

/**
 * Ends a circle — POST /v1/circles/{syncId}/delete. Appends the tombstone
 * every other device tears itself down on, then sweeps the content
 * namespace and every blob the circle owned. Meta survives, so a device
 * syncing from scratch can still verify the tombstone it finds.
 *
 * Gone (410) means someone already deleted it, which is the outcome this
 * was asking for.
 */
export async function deleteCircleOnRelay(deletion: {
  syncId: string;
  entryId: string;
  encryptedMeta: Uint8Array;
  keyVersion: number;
  writeToken: Uint8Array;
  signerAuthorityPublicKey: Uint8Array;
  signature: Uint8Array;
}): Promise<AppendResult> {
  const response = await authorizedFetch(`/v1/circles/${deletion.syncId}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entryId: deletion.entryId,
      encryptedMeta: Buffer.from(deletion.encryptedMeta).toString('base64'),
      keyVersion: deletion.keyVersion,
      writeToken: bytesToHex(deletion.writeToken),
      signerAuthorityPublicKey: bytesToHex(deletion.signerAuthorityPublicKey),
      signature: bytesToHex(deletion.signature),
    }),
  });
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to delete circle'));
  }
  const body = await response.json();
  return { epoch: body.epoch, receivedAt: body.receivedAt };
}

/**
 * Deletes a post — POST /v1/circles/{syncId}/entries/{entryId}/delete-entry.
 * Strips the post's ciphertext and deletes its blob on the relay, then
 * appends the tombstone entry (`encryptedMeta`) that already-synced
 * devices hide it on. `authorSignature` and `authority` are optional and
 * independent, same shape as `deleteBlob` — the post's own author sends
 * `authorSignature` and needs nothing else; an admin deleting someone
 * else's post sends `authority` instead.
 */
export async function deleteEntryOnRelay(
  syncId: string,
  entryId: string,
  tombstoneEntryId: string,
  encryptedMeta: Uint8Array,
  keyVersion: number,
  writeToken: Uint8Array,
  authorSignature?: Uint8Array,
  authority?: { publicKey: Uint8Array; signature: Uint8Array }
): Promise<AppendResult> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/entries/${entryId}/delete-entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writeToken: bytesToHex(writeToken),
      tombstoneEntryId,
      encryptedMeta: Buffer.from(encryptedMeta).toString('base64'),
      keyVersion,
      ...(authorSignature ? { authorSignature: bytesToHex(authorSignature) } : {}),
      ...(authority
        ? { authorityPublicKey: bytesToHex(authority.publicKey), authoritySignature: bytesToHex(authority.signature) }
        : {}),
    }),
  });
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to delete post'));
  }
  const body = await response.json();
  return { epoch: body.epoch, receivedAt: body.receivedAt };
}

/**
 * Erases everything one identity authored in a circle — POST
 * /v1/circles/{syncId}/delete-author-content. Strips every content entry's
 * ciphertext and deletes the blobs behind them in one call; the relay
 * finds the rows by the author key itself. With `tombstone` it also
 * appends the account_deleted entry other devices drop their local copies
 * on; without it (a circle already departed — no current write token to
 * append under) it strips and stops, and other members keep what they
 * already have.
 */
export async function deleteAuthorContentOnRelay(
  syncId: string,
  authorIdentityPublicKey: Uint8Array,
  authorSignature: Uint8Array,
  tombstone?: { entryId: string; encryptedMeta: Uint8Array; keyVersion: number; writeToken: Uint8Array }
): Promise<AppendResult> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/delete-author-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authorIdentityPublicKey: bytesToHex(authorIdentityPublicKey),
      authorSignature: bytesToHex(authorSignature),
      ...(tombstone
        ? {
            tombstoneEntryId: tombstone.entryId,
            encryptedMeta: Buffer.from(tombstone.encryptedMeta).toString('base64'),
            keyVersion: tombstone.keyVersion,
            writeToken: bytesToHex(tombstone.writeToken),
          }
        : {}),
    }),
  });
  if (response.status === 404) {
    throw new CircleGoneError();
  }
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to erase authored content'));
  }
  const body = await response.json();
  return { epoch: body.epoch ?? 0, receivedAt: body.receivedAt ?? 0 };
}

/** Deletes the relay account itself — sessions and manifest included. DELETE /v1/account, the account's final relay call. */
export async function deleteAccountOnRelay(): Promise<void> {
  const response = await authorizedFetch(`/v1/account`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to delete account'));
  }
}

/**
 * Fetches every entry in `namespace` after `sinceEpoch` — GET
 * /v1/circles/{syncId}/entries?namespace=&sinceEpoch=.
 *
 * An epoch is a position in that namespace's sequence, not a time. Entries
 * carry a `receivedAt` as well, which is the timestamp; paging is on the
 * counter.
 */
export async function fetchEntries(syncId: string, namespace: Namespace, sinceEpoch: number): Promise<FetchEntriesResult> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/entries?namespace=${namespace}&sinceEpoch=${sinceEpoch}`);
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to fetch entries'));
  }
  const body = await response.json();
  return {
    entries: (
      body.entries as { epoch: number; keyVersion: number; encryptedMeta: string; receivedAt: number; deletedAt?: number }[]
    ).map((entry) => ({
      epoch: entry.epoch,
      keyVersion: entry.keyVersion,
      encryptedMeta: new Uint8Array(Buffer.from(entry.encryptedMeta, 'base64')),
      receivedAt: entry.receivedAt,
      deletedAt: entry.deletedAt,
    })),
    currentEpoch: body.currentEpoch,
  };
}

export type CircleEpochs = {
  syncId: string;
  metaEpoch: number;
  contentEpoch: number;
};

/**
 * Cheap "has anything changed" check across many circles in one call —
 * POST /v1/epochs/peek, meant to be polled far more often than
 * fetchEntries itself. A circle with no server-side state yet (never
 * bootstrapped) is simply absent from the result, not an error.
 *
 * POST despite mutating nothing, and the syncIds go in the body rather
 * than a query string: this one call names *every* circle this device
 * belongs to, and query strings routinely land in access logs (see
 * getUploadTarget for the same reasoning applied to write tokens), which
 * would put the whole membership list in a log line.
 */
export async function fetchEpochs(syncIds: string[]): Promise<CircleEpochs[]> {
  const response = await authorizedFetch('/v1/epochs/peek', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ syncIds }),
  });
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to fetch epochs'));
  }
  const body = await response.json();
  return body.circles;
}
