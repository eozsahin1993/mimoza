import { sql } from 'drizzle-orm';

import { db, reopenDatabase } from '@/data/db/connection';
import { runMigrations } from '@/data/db/migrations/run';
import {
  activity,
  attachments,
  circleMembers,
  circles,
  deviceProfile,
  outbox,
  pendingRequests,
  postComments,
  postReactions,
  posts,
} from '@/data/db/schema';

/** Every circle id ever stored locally, including ones this device has left — unlike getAllCircles, nothing is filtered out, since resetAllLocalData's caller needs to clean up keystore material for all of them, not just active ones. */
export async function getAllCircleIds(): Promise<string[]> {
  const rows = await db.select({ id: circles.id }).from(circles);
  return rows.map((r) => r.id);
}

/**
 * Drops every table and re-runs migrations from scratch — a real reset,
 * unlike `resetAllLocalData`, which leaves the schema and its recorded
 * migration index in place.
 *
 * That distinction is the whole point: migrations are tracked by index, so
 * a schema left behind means an edited or renamed migration is skipped
 * silently and surfaces later as "no such column" (see migrations/run.ts).
 * Reaching for a reset is exactly when that bites.
 *
 * Reads the table list rather than naming it, so a table added later is
 * dropped too. DEV-only, same as its one caller.
 */
export async function resetDatabaseSchema(): Promise<void> {
  const tables = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const table of tables) {
    await db.run(sql.raw(`DROP TABLE IF EXISTS "${table.name}"`));
  }

  reopenDatabase();
  await runMigrations();
}

/**
 * Wipes every row, children before parents — this connection does not
 * turn on `PRAGMA foreign_keys`, so nothing cascades. Leaves the
 * keystore alone; a full device reset needs both.
 */
export async function resetAllLocalData(): Promise<void> {
  await db.delete(postComments);
  await db.delete(postReactions);
  await db.delete(outbox);
  await db.delete(attachments);
  await db.delete(posts);
  await db.delete(activity);
  await db.delete(pendingRequests);
  await db.delete(circleMembers);
  await db.delete(circles);
  await db.delete(deviceProfile);
}
