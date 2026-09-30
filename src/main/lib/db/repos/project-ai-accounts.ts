import { and, eq, inArray } from 'drizzle-orm';
import log from 'electron-log';
import type { getDatabase } from '../index';
import { type Chat, chats, claudeCodeCredentials, projectAiAccounts } from '../schema';
import { parkFlowTaskForSubChat } from './task-parking';

type Db = ReturnType<typeof getDatabase>;

/**
 * Local SQLite chat and project ↔ AI account routing repository.
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

const AI_ACCOUNT_TYPES = ['claude-code', 'codex'];

/** An AI account's provider type, or null for an unknown id (the table also holds non-AI rows). */
export async function getAiAccountType(db: Db, accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ type: claudeCodeCredentials.type })
    .from(claudeCodeCredentials)
    .where(
      and(
        eq(claudeCodeCredentials.id, accountId),
        inArray(claudeCodeCredentials.type, AI_ACCOUNT_TYPES),
      ),
    )
    .limit(1);
  return row?.type ?? null;
}

/** The account a new chat is stamped with: the project's override, else the workspace default. */
export async function getNewChatAccountId(
  db: Db,
  projectId: string | null,
): Promise<string | null> {
  const override = projectId ? await getProjectAiAccount(db, projectId) : null;
  if (override) return override.id;
  const [row] = await db
    .select({ id: claudeCodeCredentials.id })
    .from(claudeCodeCredentials)
    .where(
      and(
        eq(claudeCodeCredentials.isDefault, true),
        inArray(claudeCodeCredentials.type, AI_ACCOUNT_TYPES),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * The login a chat runs on: its stamped one, and never another provider's. Null means the chat is
 * blocked because its login was removed.
 */
export async function getChatAiAccount(
  db: Db,
  chat: Pick<Chat, 'accountId' | 'provider'>,
): Promise<{ id: string; label: string | null } | null> {
  if (!chat.accountId) return null;
  const [row] = await db
    .select({ id: claudeCodeCredentials.id, label: claudeCodeCredentials.accountLabel })
    .from(claudeCodeCredentials)
    .where(
      and(
        eq(claudeCodeCredentials.id, chat.accountId),
        eq(claudeCodeCredentials.type, chat.provider),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Blocks a turn in a chat whose login was removed, parking its Flow task like a usage limit; the
 * user then retries on another login of the chat's provider.
 */
export async function assertChatLogin(db: Db, chatId: string, subChatId: string): Promise<void> {
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat || (await getChatAiAccount(db, chat))) return;
  const message = "This chat's login was removed";
  // A failed park must not replace the error that shows the recovery rows.
  await parkFlowTaskForSubChat(db, subChatId, { kind: 'api-error', status: null, message }).catch(
    (err) => log.warn(`[chat-login] park failed for ${subChatId}:`, err),
  );
  throw Object.assign(new Error(message), { category: 'LOGIN_REMOVED' });
}

/** Move a chat in place to another login of its provider; another provider is refused. */
export async function setChatAiAccount(
  db: Db,
  chatId: string,
  accountId: string,
): Promise<'ok' | 'not-found' | 'other-provider'> {
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  const nextType = await getAiAccountType(db, accountId);
  if (!chat || !nextType) return 'not-found';
  if (nextType !== chat.provider) return 'other-provider';
  await db.update(chats).set({ accountId }).where(eq(chats.id, chatId));
  return 'ok';
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
