import { eq, inArray } from 'drizzle-orm';
import type { getDatabase } from '../index';
import { claudeCodeCredentials, projectAiAccounts } from '../schema';

type Db = ReturnType<typeof getDatabase>;

/**
 * Local SQLite project ↔ AI account routing repository.
 *
 * The table is keyed `(projectId, accountId)` — when a project has a row, that credential
 * is the override for execution. When no row exists, callers fall back to the workspace
 * default account in `claude_code_credentials`.
 *
 * Keying on the credential's primary key rather than its label is load-bearing: labels are
 * not unique, so a label-keyed override could not name a single account. Two consequences
 * fall out of the FK — deleting an account cascades its overrides away (no cleanup call
 * needed), and renaming an account cannot touch an override at all.
 *
 * Single-user single-machine DB — no userId filter.
 */

/**
 * Returns the overridden account for a project, or null when none is set (= use workspace
 * default). `id` resolves execution; `label` is display-only and comes from the same row,
 * so the two can never describe different accounts.
 */
export async function getProjectAiAccount(
  db: Db,
  projectId: string,
): Promise<{ id: string; label: string | null } | null> {
  const [row] = await db
    .select({ id: claudeCodeCredentials.id, label: claudeCodeCredentials.accountLabel })
    .from(projectAiAccounts)
    .innerJoin(claudeCodeCredentials, eq(projectAiAccounts.accountId, claudeCodeCredentials.id))
    .where(eq(projectAiAccounts.projectId, projectId))
    .limit(1);
  return row ?? null;
}

/**
 * Set or clear the per-project AI account override.
 * Passing `null` clears the override (= deletes the row).
 * Passing an id upserts: any prior override for the project is replaced.
 *
 * Transactional because replace-semantics clears the old row first and the account FK can
 * reject the insert (an id deleted between the picker listing it and this write). Un-atomic,
 * that rejection would strand the project with NO override — silently downgrading it to the
 * workspace default on a call that reported failure.
 */
export async function setProjectAiAccount(
  db: Db,
  projectId: string,
  accountId: string | null,
): Promise<void> {
  db.transaction(() => {
    db.delete(projectAiAccounts).where(eq(projectAiAccounts.projectId, projectId)).run();
    if (accountId !== null) {
      db.insert(projectAiAccounts).values({ projectId, accountId }).run();
    }
  });
}

/**
 * Batch lookup: given many project IDs, return a Map of projectId → account id for those
 * that have an override set. Projects with no override are absent from the map.
 */
export async function getProjectAiAccountsBatch(
  db: Db,
  projectIds: readonly string[],
): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({
      projectId: projectAiAccounts.projectId,
      accountId: projectAiAccounts.accountId,
    })
    .from(projectAiAccounts)
    .where(inArray(projectAiAccounts.projectId, [...projectIds]));
  return new Map(rows.map((r) => [r.projectId, r.accountId]));
}
