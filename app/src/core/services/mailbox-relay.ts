import { Buffer } from 'buffer';

import { authorizedFetch } from '@/core/services/relay';
import { JoinRequestGoneError } from '@/core/services/relay-errors';

/**
 * Thin fetch-based client for the invite mailbox's endpoints (server-side:
 * server/internal/invite/http). Same division of labor as relay.ts:
 * this module only knows how to talk to the wire, nothing about
 * invite-code derivation or decryption (that's services/crypto.ts and the
 * domain usecases that call this).
 *
 * Join requests and approvals live here rather than under invite/ because
 * device-transfer.ts (account) reuses this same channel for an unrelated
 * handoff — the naming still says "invite", the mechanism doesn't care.
 * The invite-preview endpoints below are the one part nothing else touches.
 */

export type MailboxJoinRequest = {
  requesterId: string;
  encryptedRequest: Uint8Array;
  encryptedApproval: Uint8Array | null;
  createdAt: number;
};

/** Writes a join request row — PUT /v1/invites/{inviteTag}/requests/{requesterId}. Idempotent — a retry converges rather than erroring. */
export async function putJoinRequest(inviteTag: string, requesterId: string, encryptedRequest: Uint8Array): Promise<void> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}/requests/${requesterId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedRequest: Buffer.from(encryptedRequest).toString('base64') }),
  });
  if (!response.ok) {
    throw new Error(`Failed to submit join request: ${response.status}`);
  }
}

/** Lists every pending/approved join request under an invite — GET /v1/invites/{inviteTag}/requests. Creator-side ("discover"). */
export async function listJoinRequests(inviteTag: string): Promise<MailboxJoinRequest[]> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}/requests`);
  if (!response.ok) {
    throw new Error(`Failed to list join requests: ${response.status}`);
  }
  const body = (await response.json()) as {
    requests: { requesterId: string; encryptedRequest: string; encryptedApproval: string | null; createdAt: number }[];
  };
  return body.requests.map((request) => ({
    requesterId: request.requesterId,
    encryptedRequest: new Uint8Array(Buffer.from(request.encryptedRequest, 'base64')),
    encryptedApproval: request.encryptedApproval ? new Uint8Array(Buffer.from(request.encryptedApproval, 'base64')) : null,
    createdAt: request.createdAt,
  }));
}

/**
 * Polls a specific join request's approval field — GET
 * /v1/invites/{inviteTag}/requests/{requesterId}. Requester-side
 * ("complete"). Null while still pending.
 */
export async function getJoinRequestApproval(inviteTag: string, requesterId: string): Promise<Uint8Array | null> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}/requests/${requesterId}`);
  if (response.status === 404) throw new JoinRequestGoneError();
  if (!response.ok) {
    throw new Error(`Failed to check join request: ${response.status}`);
  }
  const body = (await response.json()) as { encryptedApproval: string | null };
  return body.encryptedApproval ? new Uint8Array(Buffer.from(body.encryptedApproval, 'base64')) : null;
}

/** Approves a join request — PUT /v1/invites/{inviteTag}/requests/{requesterId}/approval. Creator-side. */
export async function putJoinApproval(inviteTag: string, requesterId: string, encryptedApproval: Uint8Array): Promise<void> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}/requests/${requesterId}/approval`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedApproval: Buffer.from(encryptedApproval).toString('base64') }),
  });
  if (!response.ok) {
    throw new Error(`Failed to approve join request: ${response.status}`);
  }
}

/** Dismisses a join request permanently ("not now") — DELETE /v1/invites/{inviteTag}/requests/{requesterId}. Creator-side. Idempotent. */
export async function deleteJoinRequest(inviteTag: string, requesterId: string): Promise<void> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}/requests/${requesterId}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`Failed to dismiss join request: ${response.status}`);
  }
}
