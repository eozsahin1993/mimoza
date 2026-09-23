import { sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { runMigrations } from '@/data/db/migrations/run';

test('applies every real migration in one pass', async () => {
  await expect(runMigrations()).resolves.toBeUndefined();

  const tables = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
  expect(tables.map((table) => table.name)).toEqual(
    expect.arrayContaining([
      'circles',
      'circle_members',
      'activity',
      'posts',
      'attachments',
      'post_comments',
      'post_reactions',
      'outbox',
      'device_profile',
      'pending_requests',
      '__migrations',
    ])
  );

  // The relay-owned block on a post and the cursors on a circle are what
  // a sync writes; a migration missing one fails as a confusing "no such
  // column" much later.
  const postColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(posts)`);
  expect(postColumns.map((column) => column.name)).toEqual(
    expect.arrayContaining([
      'updated_at',
      'comment_count',
      'reaction_counts',
      'unnamed_reactions',
      'recent_comment_ids',
      'i_reacted',
      'i_commented',
      'children_fetched_at',
    ])
  );

  const circleColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(circles)`);
  expect(circleColumns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['posts_forward_cursor', 'posts_backward_cursor', 'activity_cursor', 'needs_rewrap'])
  );
});
