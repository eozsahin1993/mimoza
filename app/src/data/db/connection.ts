import { openDatabaseSync } from 'expo-sqlite';
import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';

import * as schema from '@/data/db/schema';

type Database = ExpoSQLiteDatabase<typeof schema>;

/**
 * The handle every db/ module talks to.
 *
 * Held on `globalThis`, not in module scope, because Fast Refresh
 * re-evaluates a changed module and everything under db/ imports this
 * one. A module-level `openDatabaseSync` would open a *second* native
 * handle to the same file while screens and in-flight drains still hold
 * the first — two connections racing the migration's `BEGIN IMMEDIATE`.
 * A production build never re-evaluates, so this costs a property read.
 */
declare global {
  var __mimozaDb: Database | undefined;
}

function open(): Database {
  return drizzle(openDatabaseSync('mimoza.db'), { schema });
}

/**
 * Throws the handle away and opens a new one.
 *
 * A reload can destroy the native database while this JS runtime lives
 * on, leaving a wrapper whose native object is gone: every statement then
 * fails with `NativeDatabase.prepareSync has been rejected → NullPointerException`,
 * and nothing recovers it, because the handle is cached. Dev-only in
 * practice — a production build is never reloaded out from under itself.
 */
export function reopenDatabase(): void {
  globalThis.__mimozaDb = open();
}

/**
 * A proxy rather than the instance itself, so `reopenDatabase` can swap
 * what's underneath without every db/ module having to ask for the handle
 * through a function call — they keep importing `db` and using it exactly
 * as before.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const current = (globalThis.__mimozaDb ??= open());
    const value = Reflect.get(current, property, current);
    // Bound, or drizzle's methods lose the receiver their private fields
    // live on and fail on first use.
    return typeof value === 'function' ? value.bind(current) : value;
  },
});
