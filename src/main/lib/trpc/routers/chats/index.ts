import { router } from '../../index';
import { commitMessageRouter } from './ai';
import { archiveRouter } from './archive';
import { createRouter } from './create';
import { deleteRouter } from './delete';
import { forkRouter } from './fork';
import { getRouter } from './get';
import { diffRouter } from './git/diff';
import { parsedDiffRouter } from './git/parsed-diff';
import { switchWorktreeRouter } from './git/switch-worktree';
import { worktreeStatusRouter } from './git/worktree-status';
import { listRouter } from './list';
import { pinRouter } from './pin';
import { prContextRouter } from './pr/context';
import { prMergeRouter } from './pr/merge';
import { prStatusRouter } from './pr/status';
import { planApprovalRouter } from './stats/plan-approval';
import { subChatGetRouter, subChatRollbackRouter, subChatUpdateRouter } from './sub-chats';
import { updateRouter } from './update';

/**
 * Chats router - aggregates all chat-related sub-routers
 *
 * Structure:
 * - Chat CRUD: list, get, create, update, archive, delete
 * - Sub-chats: get, update, rollback, delete
 * - Git operations: diff, parsed-diff, worktree-status, switch-worktree
 * - PR operations: context, status, merge
 * - AI generation: commit-message, chat-name
 * - Statistics: plan-approval
 * - Export: export to various formats
 */
export const chatsRouter = router({
  // Chat CRUD operations
  ...listRouter._def.procedures,
  ...getRouter._def.procedures,
  ...createRouter._def.procedures,
  ...updateRouter._def.procedures,
  ...archiveRouter._def.procedures,
  ...deleteRouter._def.procedures,
  ...forkRouter._def.procedures,
  ...pinRouter._def.procedures,

  // Sub-chat operations
  ...subChatGetRouter._def.procedures,
  ...subChatUpdateRouter._def.procedures,
  ...subChatRollbackRouter._def.procedures,

  // Git operations
  ...diffRouter._def.procedures,
  ...parsedDiffRouter._def.procedures,
  ...worktreeStatusRouter._def.procedures,
  ...switchWorktreeRouter._def.procedures,

  // PR operations
  ...prContextRouter._def.procedures,
  ...prStatusRouter._def.procedures,
  ...prMergeRouter._def.procedures,

  // AI generation
  ...commitMessageRouter._def.procedures,

  // Statistics
  ...planApprovalRouter._def.procedures,
});
