import { eq } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { localAccount } from '@/data/db/schema';

export type LocalAccount = typeof localAccount.$inferSelect;

/** This device's own sign-in state. One row. */
export async function getLocalAccount(): Promise<LocalAccount | null> {
  const [row] = await db.select().from(localAccount).limit(1);
  return row ?? null;
}

export async function saveLocalAccount(account: typeof localAccount.$inferInsert): Promise<void> {
  await db
    .insert(localAccount)
    .values(account)
    .onConflictDoUpdate({
      target: localAccount.accountId,
      set: { name: account.name, updatedAt: account.updatedAt },
    });
}

export async function forgetLocalAccount(accountId: string): Promise<void> {
  await db.delete(localAccount).where(eq(localAccount.accountId, accountId));
}
