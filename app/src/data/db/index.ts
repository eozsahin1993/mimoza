import { runMigrations } from '@/data/db/migrations/run';

/** Brings the database up to the latest schema. Call once at app startup. */
export async function initDatabase(): Promise<void> {
  await runMigrations();
}

export * from '@/data/db/activity';
export * from '@/data/db/attachments';
export * from '@/data/db/circles';
export * from '@/data/db/comments';
export * from '@/data/db/members';
export * from '@/data/db/outbox';
export * from '@/data/db/pending-requests';
export * from '@/data/db/posts';
export * from '@/data/db/queue';
export * from '@/data/db/profile';
export * from '@/data/db/reactions';
export * from '@/data/db/reset';
