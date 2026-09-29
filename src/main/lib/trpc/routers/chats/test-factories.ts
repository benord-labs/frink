import type { Chat, SubChat } from '../../../db/schema';
import { createId } from '../../../db/utils';

/**
 * Phase 1 local-first migration: factories returning rows in the **local SQLite shape**
 * (camelCase, Date objects, schema-aligned fields). Use these in tests that exercise the
 * new chat/sub-chat repos or routers that have switched to local reads.
 *
 * The cloud-shape factory `makeChat` in `create.test.ts` (snake_case + ISO strings) is
 * preserved for tests that still mock cloud-client responses during the dual-write phase.
 * Once a router is fully on local reads, its tests should swap to `makeLocalChat`.
 */

export function makeLocalChat(overrides: Partial<Chat> = {}): Chat {
  const now = new Date();
  return {
    id: createId(),
    name: 'Test chat',
    projectId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    prNumber: null,
    taskId: null,
    mode: 'agent',
    pinnedAt: null,
    worktreeHistory: null,
    composerModelId: null,
    composerAutoMode: null,
    composerCodexSpeed: null,
    ...overrides,
  };
}

export function makeLocalSubChat(overrides: Partial<SubChat> = {}): SubChat {
  const now = new Date();
  return {
    id: createId(),
    chatId: 'chat-id',
    name: null,
    sessionId: null,
    streamId: null,
    mode: 'agent',
    messages: '[]',
    additions: 0,
    deletions: 0,
    fileCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
