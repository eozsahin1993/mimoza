import { sql } from 'drizzle-orm';

import { db, reopenDatabase } from '@/data/db/connection';
import migrationsData from '@/data/db/migrations/migrations';

/**
 * Memoizes the in-flight/completed migration run so every caller awaits the
 * same promise rather than each starting their own — e.g. React Strict Mode
 * invoking a mount effect twice in development. Only protects against two
 * calls within the same running JS instance; see the transaction below for
 * what actually protects the data itself.
 *
 * On `globalThis` for the same reason the connection is (see
 * connection.ts): Fast Refresh re-evaluating this module would otherwise
 * reset the memo and let a second batch start while the first is still
 * inside `BEGIN IMMEDIATE` — exactly the case where a schema change is
 * being reloaded into a running app.
 */
declare global {
  var __mimozaMigrations: Promise<void> | undefined;
}

export function runMigrations(): Promise<void> {
  globalThis.__mimozaMigrations ??= runMigrationsOnce();
  return globalThis.__mimozaMigrations;
}

// Not `__drizzle_migrations` — its schema and lookup logic are entirely
// our own now (tracked by tag, not drizzle's created_at watermark), so
// keeping drizzle's name while diverging from its format would be more
// confusing than a clean break.
const MIGRATIONS_TABLE = sql.identifier('__migrations');

/**
 * Hand-rolled migration runner — deliberately not drizzle-orm's own
 * `migrate()`. Every sync SQLite driver drizzle ships, expo-sqlite
 * included, has a bug where the transaction wrapper doesn't await its
 * (async) callback, so COMMIT fires after the first statement instead of
 * after the whole batch: https://github.com/drizzle-team/drizzle-orm/issues/2275
 * (confirmed: 4 of drizzle's 5 SQLite driver adapters have this, only
 * sqlite-proxy awaits correctly — it's a bug in drizzle's own wrapper code,
 * not a SQLite or Expo limitation). That makes drizzle's "transactional"
 * migrations non-atomic in practice.
 *
 * This runner fixes the actual bug instead of working around its absence:
 * it wraps the whole batch of pending migrations in one real transaction,
 * with every statement properly awaited. SQLite itself guarantees an
 * uncommitted transaction never becomes visible to any connection — verified
 * directly: opening a transaction, writing to it, and closing the connection
 * without COMMIT leaves nothing behind for a fresh connection to see. So if
 * the app gets killed or reloaded mid-migration, nothing partial is ever
 * left on disk to collide with the next attempt; the next launch just
 * starts the same batch over from scratch.
 *
 * It also tracks applied migrations by their sequential idx ("has migration
 * 3 run?"), not drizzle's own approach of comparing against the single
 * latest timestamp seen ("has anything at least this recent run?") —
 * drizzle does that the same way in every dialect it ships, not just this
 * one, but a watermark can't detect a gap, only ever assume there isn't
 * one. Checking by identity doesn't rely on that assumption. It's keyed on
 * idx specifically, not the journal's `tag` (e.g. "0003_cold_tyrannus") —
 * tag is idx plus a randomly-generated, purely cosmetic slug that exists
 * for human-readable filenames, not to be a stable identity; renaming a
 * migration file would silently break tag-based tracking for anyone who'd
 * already applied it.
 */
async function runMigrationsOnce(): Promise<void> {
  // No PRAGMA busy_timeout means a second connection hitting a locked
  // database (e.g. an overlapping app instance from a Fast Refresh reload
  // or relaunch racing this one) fails immediately with "database is
  // locked" instead of waiting for this transaction to finish.
  //
  // Doubles as the liveness probe for the handle: a reload can destroy the
  // native database under a JS runtime that survives it, and every
  // statement then fails on a null native object. Reopening here is what
  // makes that recoverable without relaunching the app.
  try {
    await db.run(sql`PRAGMA busy_timeout = 5000;`);
  } catch (err) {
    console.warn('Reopening the database — the handle did not survive a reload', err);
    reopenDatabase();
    await db.run(sql`PRAGMA busy_timeout = 5000;`);
  }
  await db.run(sql`PRAGMA foreign_keys = ON;`);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      idx integer PRIMARY KEY NOT NULL,
      applied_at integer NOT NULL
    )
  `);

  const applied = await db.all<{ idx: number }>(sql`SELECT idx FROM ${MIGRATIONS_TABLE}`);
  const appliedIdxs = new Set(applied.map((row) => row.idx));
  const pending = migrationsData.journal.entries.filter((entry) => !appliedIdxs.has(entry.idx));
  if (pending.length === 0) {
    return;
  }

  // BEGIN IMMEDIATE claims the write lock up front, rather than deferring
  // it to the first write — so a second connection hitting this mid-batch
  // waits on PRAGMA busy_timeout right away instead of getting partway in.
  await db.run(sql`BEGIN IMMEDIATE`);
  try {
    for (const entry of pending) {
      const key = `m${entry.idx.toString().padStart(4, '0')}` as keyof typeof migrationsData.migrations;
      const migrationSql = migrationsData.migrations[key] as string;
      const statements = migrationSql
        .split('--> statement-breakpoint')
        .map((statement: string) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) {
        await db.run(sql.raw(statement));
      }
      await db.run(sql`INSERT INTO ${MIGRATIONS_TABLE} (idx, applied_at) VALUES (${entry.idx}, ${Date.now()})`);
    }
    await db.run(sql`COMMIT`);
  } catch (error) {
    await db.run(sql`ROLLBACK`);
    throw error;
  }
}
