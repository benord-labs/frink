import log from 'electron-log';
import { z } from 'zod';
import { trackWorkspaceDeleted } from '../../../analytics';
import { getDatabase } from '../../../db';
import { getChatById as getChatByIdLocal } from '../../../db/repos/chats';
import { listSubChatsByChat as listSubChatsByChatLocal } from '../../../db/repos/sub-chats';
import { deleteChatWithFlowQueueTasks } from '../../../db/repos/task-queries/chat-flow-cleanup';
import { settleChatOwnedFlowDeletion } from '../../../flows/deletion';
import { cancelFlowRunsForChatOrThrow } from '../../../flows/engine';
import { gitCache } from '../../../git/cache';
import {
  abortActiveExecutionsForSubChats,
  clearCodexSession,
  collectLiveSubChatIdsForChat,
} from '../../../socket/executor';
import { terminalManager } from '../../../terminal/manager';
import { publicProcedure, router } from '../../index';
import { mapLocalChatResponse } from './map-chat-response';
import { tearDownChatWorktree } from './teardown-worktree';

/**
 * Chat deletion operations.
 *
 * Phase 1 local-first migration: deletes go to local SQLite directly. Worktree teardown
 * runs in the background using local git tooling (sibling check via the local repo).
 */
export const deleteRouter = router({
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const db = getDatabase();

    const chat = await getChatByIdLocal(db, input.id).catch((error) => {
      log.warn('[chats.delete] getChatById failed:', error);
      return null;
    });

    if (!chat) {
      // No chat to delete — still clear any stale cursor cache for this id, in case the
      // renderer kept a stale reference. Don't abort executors: there's nothing to abort
      // and we don't want to nuke an active execution for a coincidentally-matching id.
      clearCodexSession(input.id);
      return null;
    }

    // Phase 1 ship-blocker fix (commit 6056c8): abort any active executions BEFORE we
    // flip the local row + remove the worktree. Without this, the SDK keeps streaming
    // and tool-calling against a worktree we're about to yank from under it. The live
    // sub-chats come from memory, so a failed DB lookup still stops every running turn.
    const subChats = await listSubChatsByChatLocal(db, chat.id).catch((error) => {
      log.warn('[chats.delete] listSubChatsByChat failed; aborting live turns only', error);
      return [];
    });
    abortActiveExecutionsForSubChats(
      [...new Set([...subChats.map((sc) => sc.id), ...collectLiveSubChatIdsForChat(chat.id)])],
      'chat deleted',
    );
    clearCodexSession(input.id);

    // Cancel the flow runs this chat drives, else they keep running after the chat is gone
    // (JSON-only link, no FK cascade — the local migration dropped this).
    await cancelFlowRunsForChatOrThrow(chat.id);
    await settleChatOwnedFlowDeletion(() => deleteChatWithFlowQueueTasks(db, input.id));

    // Background worktree teardown (chat row already gone — housekeeping). Kill terminals cwd'd in
    // the worktree first so they don't hold a handle that blocks `git worktree remove`; the helper
    // does the tri-state sibling check + retrying removal, and the boot sweep backstops failures.
    void (async () => {
      await terminalManager.killByWorkspaceId(chat.id).catch(() => {});
      await tearDownChatWorktree(db, chat);
    })();

    trackWorkspaceDeleted(input.id);
    if (chat.worktreePath) {
      gitCache.invalidateStatus(chat.worktreePath);
      gitCache.invalidateParsedDiff(chat.worktreePath);
    }

    return mapLocalChatResponse(chat);
  }),
});
