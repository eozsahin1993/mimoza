import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { outbox } from '@/data/db/schema';

export type { OutboxOp } from '@/data/db/schema';

export type OutboxEntry = typeof outbox.$inferSelect;
export type NewOutboxEntry = typeof outbox.$inferInsert;

export async function enqueue(entry: NewOutboxEntry): Promise<number> {
  const [row] = await db.insert(outbox).values(entry).returning({ seq: outbox.seq });
  return row.seq;
}

/**
 * What to send for one circle now: its queued rows in the order they
 * were made, up to the first one still waiting out a backoff.
 *
 * Stopping there rather than skipping past is the point. A comment must
 * never overtake the post it is on, so a row that failed holds back
 * everything queued behind it until it goes out.
 */
export async function due(circleId: string, now: number): Promise<OutboxEntry[]> {
  const rows = await db
    .select()
    .from(outbox)
    .where(and(eq(outbox.circleId, circleId), eq(outbox.status, 'queued')))
    .orderBy(asc(outbox.seq));

  const waiting = rows.findIndex((row) => row.nextAttemptAt !== null && row.nextAttemptAt > now);
  return waiting === -1 ? rows : rows.slice(0, waiting);
}

export async function done(seq: number): Promise<void> {
  await db.delete(outbox).where(eq(outbox.seq, seq));
}

/**
 * A failure that is worth another go. The delay grows with each attempt;
 * past the budget the row is marked failed and surfaces as a banner
 * rather than retrying forever.
 */
export async function retryLater(seq: number, attempts: number, at: number, error: string): Promise<void> {
  const budget = 5;
  if (attempts >= budget) {
    await db.update(outbox).set({ status: 'failed', attempts, lastError: error }).where(eq(outbox.seq, seq));
    return;
  }
  await db
    .update(outbox)
    .set({ attempts, nextAttemptAt: at, lastError: error })
    .where(eq(outbox.seq, seq));
}

/**
 * Waits without spending an attempt — for a failure that says nothing
 * about the write itself, so the budget stays for refusals the relay
 * actually made. Flat rather than growing: there is no server to be
 * gentle with, and the scheduler comes back every 30 seconds anyway.
 */
export async function defer(seq: number, at: number, error: string): Promise<void> {
  await db.update(outbox).set({ nextAttemptAt: at, lastError: error }).where(eq(outbox.seq, seq));
}

export async function failed(circleId?: string): Promise<OutboxEntry[]> {
  const where = circleId
    ? and(eq(outbox.status, 'failed'), eq(outbox.circleId, circleId))
    : eq(outbox.status, 'failed');
  return db.select().from(outbox).where(where).orderBy(asc(outbox.seq));
}

export async function discard(seq: number): Promise<void> {
  await db.delete(outbox).where(eq(outbox.seq, seq));
}

/** Everything queued for one post, which is what the card adjusts by. */
export async function queuedFor(postId: string): Promise<OutboxEntry[]> {
  return db
    .select()
    .from(outbox)
    .where(and(eq(outbox.postId, postId), eq(outbox.status, 'queued')))
    .orderBy(asc(outbox.seq));
}
