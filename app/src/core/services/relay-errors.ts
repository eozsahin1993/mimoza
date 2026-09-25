/**
 * Every named error the relay services throw, in one place — each is
 * identifiable via `instanceof` by the usecase that needs to react to it
 * specifically, rather than parsing a message string. Kept together
 * rather than beside each endpoint that throws them so a caller doesn't
 * need to know which `*-relay.ts` module owns a given failure just to
 * catch it.
 */

/**
 * Thrown on HTTP 401: the relay no longer accepts this device's session.
 * Expiry is the ordinary cause — sessions last 90 days and nothing
 * renews them — deleting the account elsewhere the other. Callers needn't
 * catch it: `authorizedFetch` has already dropped the token and sent the
 * person back to sign in by the time this surfaces.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Your session ended — sign in again.');
    this.name = 'SessionExpiredError';
  }
}

/** Thrown on HTTP 429 (see server/internal/ratelimit) — not handled specially, just identifiable in logs. Callers already retry any thrown error later (outbox, pullMeta, photo-queue.ts), and the budget is sized to make this rare. */
export class RateLimitedError extends Error {
  constructor() {
    super('Rate limit exceeded — try again shortly.');
    this.name = 'RateLimitedError';
  }
}

/**
 * The request never reached the relay — no radio, no route, a captive
 * portal. Distinct from every other error here because nothing is wrong
 * with what was being sent: a queued write must not spend its retry
 * budget on it and end up in the failed banner for being on a plane.
 */
export class NetworkUnreachableError extends Error {
  constructor() {
    super('Could not reach the relay.');
    this.name = 'NetworkUnreachableError';
  }
}

/** Thrown by `getUploadTarget` specifically — see its own doc comment for why this isn't necessarily a failure. */
export class BlobAlreadyExistsError extends Error {
  constructor() {
    super('A blob already exists for this entry.');
    this.name = 'BlobAlreadyExistsError';
  }
}

/**
 * Thrown when the relay refuses to delete a blob (403): this device
 * neither uploaded it nor holds an admin key the circle recognises. A
 * permanent refusal, not a transient one — see `deleteBlobFor`, which
 * gives up on the bytes rather than blocking the queue behind it.
 */
export class BlobDeleteRefusedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'BlobDeleteRefusedError';
  }
}

/** The relay refused a strip because the circle no longer exists — deleted for everyone, so the erase is already done. */
export class CircleGoneError extends Error {
  constructor() {
    super('The circle no longer exists on the relay.');
    this.name = 'CircleGoneError';
  }
}

/**
 * Raised when a join request's row is gone: the creator denied it, or it
 * aged out. Permanent either way — a caller that keeps polling will keep
 * getting it, so this is the signal to stop and say so.
 */
export class JoinRequestGoneError extends Error {
  constructor() {
    super('That join request is no longer waiting for an answer.');
    this.name = 'JoinRequestGoneError';
  }
}

/**
 * Raised when a device-link session is gone: it expired, or it never
 * existed on this account. Permanent — the phones have to start a new
 * handshake, since the throwaway key the old one was sealed to is the
 * only thing that could have opened it.
 */
export class DeviceLinkGoneError extends Error {
  constructor() {
    super('That device link is no longer open.');
    this.name = 'DeviceLinkGoneError';
  }
}

/**
 * Raised when a device-link session already holds a sealed keypair.
 * First answer wins, so a second scan of the same code is refused rather
 * than overwriting what the waiting phone is about to collect.
 */
export class DeviceLinkAnsweredError extends Error {
  constructor() {
    super('That code was already used by another device.');
    this.name = 'DeviceLinkAnsweredError';
  }
}
