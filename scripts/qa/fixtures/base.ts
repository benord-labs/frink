/** Shared fixture plumbing: the database type, fixed timestamps, the workspace ids and transcript seeding. */
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from '../../../src/main/lib/db/schema';

export type SqliteDb = BaseSQLiteDatabase<'sync', unknown, typeof schema>;

// Fixed moments (not `new Date()`): stable sidebar ordering + stable relative
// labels far in the past ("in 2026") rather than flapping "2 minutes ago".
export const T0 = new Date('2026-01-01T10:00:00Z');
export const T1 = new Date('2026-01-01T11:00:00Z');
export const T2 = new Date('2026-01-01T12:00:00Z');
// Newest moment, reserved for the interrupted fixture so its chat sorts FIRST in the sidebar. That
// is the only way a driver reaches it: a restart-interrupted run is `cancelled`, so it appears in
// none of the work queue's Inbox / Active / Needs-attention buckets (the deferred Work-Queue
// discoverability gap in docs/decisions/flow-run-restart-recovery.md), leaving the chat list as its
// sole entry point.
export const T3 = new Date('2026-01-01T13:00:00Z');

export const FIXTURE_PROJECT_ID = 'qa-fixture-project';
export const FIXTURE_CHAT_EMPTY_ID = 'qa-fixture-chat-empty';
export const FIXTURE_CHAT_SEEDED_ID = 'qa-fixture-chat-seeded';
export const FIXTURE_SUB_CHAT_ID = 'qa-fixture-subchat-1';
/** A long transcript (24 messages, ~400 KB assistant turns) for scripts/perf drivers. */
export const FIXTURE_LONG_CHAT_ID = 'qa-fixture-chat-long';
export const FIXTURE_LONG_SUB_CHAT_ID = 'qa-fixture-subchat-long';
export const FIXTURE_LONG_CHAT_NAME = 'Long transcript';
export const FIXTURE_TASK_ID = 'qa-fixture-task-1';
export const FIXTURE_HISTORY_COMPLETED_ID = 'qavis-history-completed';
export const FIXTURE_HISTORY_CANCELLED_ID = 'qavis-history-cancelled';
export const FIXTURE_ACCOUNT_ID = 'qa-fixture-account-1';
/** An empty file in the rig home that stands in for the Claude login the account's probe looks for. */
export const FIXTURE_CLAUDE_SOURCE_MARKER = 'qa-claude-login-marker';

/**
 * The `source_path` for a file on disk. Never percent-encode: the probe checks the path exactly as
 * stored, and the rig home has spaces in it.
 */
export function fixtureSourceUri(absolutePath: string): string {
  return `file://${absolutePath}`;
}
export const FIXTURE_HTML_ARTIFACT_ID = 'qa-fixture-customer-message-digest';
export const FIXTURE_HTML_ARTIFACT_TITLE = 'Customer message digest · 18–22 Aug';

/** A transcript is one `sub_chat_messages` row per message, in order. */
export function seedTranscript(
  db: SqliteDb,
  subChatId: string,
  messages: readonly unknown[],
): void {
  db.insert(schema.subChatMessages)
    .values(messages.map((message, seq) => ({ subChatId, seq, message: JSON.stringify(message) })))
    .run();
}
